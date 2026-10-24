// The build watcher: nightly, for each Docker package with a repository in the community namespace, two things the
// upstream watcher (upstream.ts) doesn't cover. First-party tools (not community-packaged) pin their PyPI dependencies
// in requirements.txt; each pin is compared with PyPI's latest release, and UPSTREAM_WATCH decides what happens: report,
// issues (an issue per dependency release three days after it), prs (also a pull request from the community bot
// updating requirements.txt, released like a bump) or auto (also released on its own a week after the release). Every
// build's base image (the Dockerfile's last FROM) is looked up on Docker Hub: when its digest has changed since the
// version was first seen and that version's scan found fixable critical or high vulnerabilities, REBUILD_WATCH=rebuild
// has the bot run the release workflow again on unchanged source, as a new patch version, at most every two weeks per
// package and five a day. Dependency updates and rebuilds are rows in bump_prs (kind dependency or rebuild), so
// bumps.ts releases, follows and settles them. Tables are in migration 0031.
import { deps, type Env } from "./env";
import * as github from "./hosts/github";
import { HostError } from "./hosts/github";
import { sha256Hex } from "./lib/crypto";
import { audit } from "./routes/auth";
import { closeSystemIssue, fileSystemIssue } from "./community";
import { COMMUNITY_NAMESPACE } from "./imports";
import { botConfigured, botToken } from "./submissions";
import { overLimit } from "./trust";
import { compareVersions, ISSUE_AFTER, readToken, watchMode } from "./upstream";
import {
  AUTO_AFTER, AUTO_PER_DAY, AUTO_PR_AGE, DAY, failBump, nextPatch, pinOnly, releaseBump, upstreamSemver, WORKFLOW, type BumpRow, type Tool as BumpTool,
} from "./bumps";

export type DependencyState = "current" | "behind" | "unknown" | "error";
export type DependencyRow = {
  tool_id: string; ecosystem: "pypi"; package: string; pinned: string; latest: string | null; latest_at: number | null; state: DependencyState;
  error: string | null; pinned_version_id: string | null; checked_at: number | null; changed_at: number | null;
};
export type BaseState = "current" | "updated" | "unknown" | "error";
export type BaseRow = {
  tool_id: string; image: string | null; built_digest: string | null; latest_digest: string | null; pinned_version_id: string | null; state: BaseState;
  error: string | null; rebuilt_at: number | null; checked_at: number | null; changed_at: number | null;
};
export type RebuildMode = "report" | "rebuild";

/** Whether the registry rebuilds packages on a newer base image; anything but "rebuild" only records what it finds. */
export const rebuildMode = (env: Env): RebuildMode => (env.REBUILD_WATCH === "rebuild" ? "rebuild" : "report");

/** A package is rebuilt at most this often, and no more than this many a day across the registry. */
const REBUILD_EVERY = 14 * DAY;
const REBUILDS_PER_DAY = 5;
/** A base image's digest is looked up again once it is older than this, so one night's checks share one lookup. */
const BASE_FRESH = 20 * 3_600_000;

type Tool = BumpTool & {
  latest_version_id: string; git_sha: string | null; status: string; auto_release: number; community_packaged: number;
};

/** Queues a check of every published Docker package with a repository in the community namespace; runs nightly. */
export async function queueBuildChecks(env: Env) {
  const tools = (await env.DB.prepare(
    `SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id JOIN sources s ON s.tool_id = t.id
     WHERE n.name = ? AND t.status != 'removed' AND v.runtime_kind = 'docker'`,
  ).bind(COMMUNITY_NAMESPACE).all<{ id: string }>()).results;
  for (let i = 0; i < tools.length; i += 100) {
    await env.PUBLISH_QUEUE.sendBatch(tools.slice(i, i + 100).map((t) => ({ body: { buildCheckToolId: t.id } })));
  }
  return tools.length;
}

/** Checks one package's dependencies (first-party tools only) and base image. Only the nightly check acts on its own. */
export async function checkBuild(env: Env, toolId: string, now = Date.now(), opts: { nightly?: boolean } = {}) {
  const t = await env.DB.prepare(
    `SELECT t.id, t.name, n.name AS ns, t.namespace_id, t.upstream_url, t.latest_version_id, t.status, t.auto_release, t.community_packaged,
       v.manifest_json, v.git_sha, s.path AS wrapper
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id LEFT JOIN sources s ON s.tool_id = t.id
     WHERE t.id = ? AND t.status != 'removed'`,
  ).bind(toolId).first<Tool>();
  if (!t?.wrapper) return null;
  const token = await readToken(env);
  const dependencies = t.community_packaged ? [] : await checkDependencies(env, t, token, now, opts);
  const base = await checkBaseImage(env, t, token, now, opts);
  return { dependencies, base };
}

// ---------- dependencies ----------

/** The exact pins of a requirements.txt (name==version, extras and markers allowed); anything looser is left alone. */
export function parseRequirements(text: string): { package: string; pinned: string }[] {
  const out: { package: string; pinned: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)\s*(?:;.*)?$/.exec(line);
    if (m) out.push({ package: m[1]!, pinned: m[2]! });
  }
  return out;
}

async function pypiLatest(pkg: string): Promise<{ latest: string; latest_at: number | null } | { error: string }> {
  const res = await deps.fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { headers: { Accept: "application/json" } });
  if (!res.ok) return { error: `PyPI answered ${res.status} for ${pkg}` };
  const body = (await res.json()) as { info: { version: string }; releases?: Record<string, { upload_time_iso_8601?: string }[]> };
  const at = body.releases?.[body.info.version]?.[0]?.upload_time_iso_8601;
  return { latest: body.info.version, latest_at: at ? Date.parse(at) : null };
}

/** Compares each requirements.txt pin of the latest version with PyPI, records it, and acts on it per UPSTREAM_WATCH. */
async function checkDependencies(env: Env, t: Tool, token: string, now: number, opts: { nightly?: boolean }): Promise<DependencyRow[]> {
  const prev = (await env.DB.prepare(`SELECT * FROM dependency_watch WHERE tool_id = ?`).bind(t.id).all<DependencyRow>()).results;
  // requirements.txt only changes with a new version, so it is read again only then.
  let pins: { package: string; pinned: string }[];
  if (prev.length && prev.every((r) => r.pinned_version_id === t.latest_version_id)) pins = prev.map((r) => ({ package: r.package, pinned: r.pinned }));
  else {
    const text = t.git_sha ? await github.fileAt(deps.fetch, token, t.wrapper!, "requirements.txt", t.git_sha).catch(() => null) : null;
    pins = text ? parseRequirements(text) : [];
  }
  const rows: DependencyRow[] = [];
  for (const p of pins) {
    const before = prev.find((r) => r.package === p.package);
    const row: DependencyRow = {
      tool_id: t.id, ecosystem: "pypi", package: p.package, pinned: p.pinned, latest: before?.latest ?? null, latest_at: before?.latest_at ?? null,
      state: "unknown", error: null, pinned_version_id: t.latest_version_id, checked_at: now, changed_at: before?.changed_at ?? now,
    };
    try {
      const rel = await pypiLatest(p.package);
      if ("error" in rel) throw new Error(rel.error);
      row.latest = rel.latest;
      row.latest_at = rel.latest_at;
      const cmp = compareVersions(p.pinned, rel.latest);
      if (cmp === null) row.error = `can't compare the pinned ${p.pinned} with PyPI's ${rel.latest}`;
      else row.state = cmp < 0 ? "behind" : "current";
    } catch (e) {
      row.state = "error";
      row.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    if (!before || before.state !== row.state || before.latest !== row.latest || before.pinned !== row.pinned) row.changed_at = now;
    rows.push(row);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dependency_watch WHERE tool_id = ?`).bind(t.id),
    ...rows.map((r) => env.DB.prepare(
      `INSERT INTO dependency_watch (tool_id, ecosystem, package, pinned, latest, latest_at, state, error, pinned_version_id, checked_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(r.tool_id, r.ecosystem, r.package, r.pinned, r.latest, r.latest_at, r.state, r.error, r.pinned_version_id, r.checked_at, r.changed_at)),
  ]);
  const mode = watchMode(env);
  const bump = mode === "prs" || mode === "auto" ? await maybeOpenDependencyBump(env, t, rows, now).catch((e) => (console.error("the dependency pull request failed", e), null)) : null;
  if (mode !== "report") await dependencyIssues(env, t, rows, now, bump);
  if (mode === "auto" && opts.nightly) {
    await maybeAutoReleaseDependencies(env, t, rows, bump, now).catch((e) => console.error("releasing the dependency update on its own failed", e));
  }
  return rows;
}

/** Releases due for an issue or a pull request: behind a stable release that came out three days ago or more. */
const due = (rows: DependencyRow[], now: number) =>
  rows.filter((r) => r.state === "behind" && r.latest && upstreamSemver(r.latest) && (r.latest_at ?? 0) <= now - ISSUE_AFTER);

/**
 * Issues mode: an outdated issue per dependency release (closed as superseded when PyPI has a newer one, or fixed once
 * a published version pins it); issues about a dependency that is no longer pinned close too.
 */
async function dependencyIssues(env: Env, t: Tool, rows: DependencyRow[], now: number, bump: BumpRow | null) {
  const ref = `${t.ns}/${t.name}`;
  const open = (await env.DB.prepare(
    `SELECT dedupe_key FROM issues WHERE tool_id = ? AND dedupe_key LIKE 'dependency:%' AND status IN ('open', 'confirmed')`,
  ).bind(t.id).all<{ dedupe_key: string }>()).results.map((r) => r.dedupe_key);
  const keep = new Set<string>();
  for (const r of due(rows, now)) {
    const key = `dependency:${r.package}==${r.latest}`;
    keep.add(key);
    const inBump = bump?.kind === "dependency" && bump.version.split(",").includes(`${r.package}==${r.latest}`);
    await fileSystemIssue(env, t.id, "outdated", {
      title: `${r.package} ${r.latest} is out`,
      markdown: `${ref} pins **${r.package} ${r.pinned}** in \`requirements.txt\`; PyPI has **${r.latest}**${r.latest_at ? ` since ${new Date(r.latest_at).toISOString().slice(0, 10)}` : ""}. ` +
        `${inBump ? `[A pull request updates it](${bump!.url}); a maintainer merges and releases it from the package page.` : "A maintainer updates the pin and releases a new version."} ` +
        `This issue closes when a version pinning ${r.package} ${r.latest} is published.`,
    }, key, "build_watch");
  }
  for (const key of open.filter((k) => !keep.has(k))) {
    const [pkg, version] = key.slice("dependency:".length).split("==");
    const row = rows.find((r) => r.package === pkg);
    if (!row) await closeSystemIssue(env, t.id, key, "wont_fix", `${pkg} is no longer pinned.`);
    else if (row.state === "current" || (row.pinned && compareVersions(row.pinned, version!) !== -1)) await closeSystemIssue(env, t.id, key, "fixed", `The published package now pins ${pkg} ${row.pinned}.`);
    else if (row.latest && row.latest !== version) await closeSystemIssue(env, t.id, key, "wont_fix", `PyPI has released ${pkg} ${row.latest} since.`);
  }
}

/** requirements.txt on main with each due pin changed; null when main pins something else since the release. */
async function planDependencies(token: string, t: Tool, rows: DependencyRow[]): Promise<github.FileChange | null> {
  const text = await github.fileAt(deps.fetch, token, t.wrapper!, "requirements.txt", "main");
  if (!text) return null;
  const lines = text.split("\n");
  for (const r of rows) {
    const re = new RegExp(`^(${r.package.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\[[^\\]]*\\])?\\s*==\\s*)([A-Za-z0-9.!+_-]+)`, "i");
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0 || re.exec(lines[i]!)![2] !== r.pinned) return null;
    lines[i] = lines[i]!.replace(re, `$1${r.latest}`);
  }
  const next = lines.join("\n");
  return next === text ? null : { path: "requirements.txt", content: next };
}

/**
 * Opens one pull request per package updating every due pin in requirements.txt, once per set of releases; a newer set
 * closes the older pull request, on GitHub too.
 */
async function maybeOpenDependencyBump(env: Env, t: Tool, rows: DependencyRow[], now: number): Promise<BumpRow | null> {
  const ready = due(rows, now);
  if (!botConfigured(env) || !ready.length) return null;
  const key = ready.map((r) => `${r.package}==${r.latest}`).sort().join(",");
  const existing = await env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, key).first<BumpRow>();
  if (existing) return existing;
  const token = await botToken(env);
  const file = await planDependencies(token, t, ready);
  if (!file) return null;
  const branch = `otinstaller/deps-${(await sha256Hex(key)).slice(0, 10)}`;
  const title = `Update ${t.name}'s dependencies: ${ready.map((r) => `${r.package} ${r.latest}`).join(", ")}`;
  const body = `PyPI has newer releases of what \`requirements.txt\` pins:\n\n${ready.map((r) => `- ${r.package} ${r.pinned} → ${r.latest}`).join("\n")}\n\n` +
    `This changes only those pins. A maintainer of ${t.ns}/${t.name} can merge and release it from the package's page on otinstaller.com; ` +
    `the release is built, signed, scanned and smoke-tested like any other.`;
  let pr: { url: string; number: number };
  try {
    pr = await github.openPullRequest(deps.fetch, token, t.wrapper!, "main", branch, [file], title, body);
  } catch (e) {
    if (e instanceof HostError) return (console.error("opening the dependency pull request failed", e), null);
    throw e;
  }
  const older = (await env.DB.prepare(`SELECT pr_number FROM bump_prs WHERE tool_id = ? AND kind = 'dependency' AND status = 'open' AND version != ?`).bind(t.id, key).all<{ pr_number: number }>()).results;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO bump_prs (tool_id, kind, version, pr_number, url, branch, created_at, updated_at) VALUES (?, 'dependency', ?, ?, ?, ?, ?, ?)`)
      .bind(t.id, key, pr.number, pr.url, branch, now, now),
    env.DB.prepare(`UPDATE bump_prs SET status = 'closed', updated_at = ? WHERE tool_id = ? AND kind = 'dependency' AND status IN ('open', 'failed') AND version != ?`).bind(now, t.id, key),
    audit(env.DB, null, "system", "bump.open", "tool", t.id, { kind: "dependency", version: key, pr: pr.url }),
  ]);
  for (const o of older) {
    if (o.pr_number !== pr.number) await github.closePull(deps.fetch, token, t.wrapper!, o.pr_number).catch((e) => console.error("closing a superseded dependency update failed", e));
  }
  return env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, key).first<BumpRow>();
}

/** When an open dependency update goes out on its own in auto mode: a week after the newest release in it, four days after it opened. */
export function dependencyAutoAt(rows: Pick<DependencyRow, "package" | "latest_at">[], bump: Pick<BumpRow, "version" | "created_at">): number {
  const names = new Set(bump.version.split(",").map((p) => p.split("==")[0]));
  const newest = Math.max(...rows.filter((r) => names.has(r.package)).map((r) => r.latest_at ?? bump.created_at), bump.created_at - AUTO_AFTER);
  return Math.max(newest + AUTO_AFTER, bump.created_at + AUTO_PR_AGE);
}

/**
 * Auto mode, like maybeAutoRelease for wrappers: the open update still names PyPI's latest release of each package, the
 * date has passed, the package lives in the community namespace and its maintainers haven't turned this off, the pull
 * request is still open and changes exactly the planned requirements.txt, and fewer than ten bumps went out today.
 */
async function maybeAutoReleaseDependencies(env: Env, t: Tool, rows: DependencyRow[], bump: BumpRow | null, now: number): Promise<boolean> {
  if (!bump || bump.kind !== "dependency" || bump.status !== "open") return false;
  const wanted = new Map(bump.version.split(",").map((p) => p.split("==") as [string, string]));
  const inBump = rows.filter((r) => wanted.has(r.package));
  if (inBump.length !== wanted.size || inBump.some((r) => r.state !== "behind" || r.latest !== wanted.get(r.package))) return false;
  if (now < dependencyAutoAt(inBump, bump) || t.ns !== COMMUNITY_NAMESPACE || !t.auto_release || t.status !== "active") return false;
  const token = await botToken(env);
  const pr = await github.getPull(deps.fetch, token, t.wrapper!, bump.pr_number);
  if (pr.state !== "open") {
    await env.DB.prepare(`UPDATE bump_prs SET status = 'closed', updated_at = ? WHERE tool_id = ? AND version = ? AND status = 'open'`).bind(now, t.id, bump.version).run();
    return false;
  }
  const planned = await planDependencies(token, t, inBump);
  const onBranch = planned ? await github.fileAt(deps.fetch, token, t.wrapper!, planned.path, bump.branch) : null;
  const files = await github.pullFiles(deps.fetch, token, t.wrapper!, bump.pr_number);
  if (!planned || onBranch !== planned.content || files.length !== 1 || files[0]!.filename !== planned.path || !pinOnly(files)) return false;
  if (await overLimit(env, "auto_release", "all", AUTO_PER_DAY, DAY, now)) return false;
  await releaseBump(env, t, bump, { actorId: null, auto: true });
  return true;
}

// ---------- base images ----------

/** The image the final build stage starts from (the last FROM), or null for scratch or an earlier stage. */
export function baseImage(dockerfile: string): string | null {
  const stages: string[] = [];
  let last: string | null = null;
  for (const line of dockerfile.split("\n")) {
    const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) continue;
    last = m[1]!;
    if (m[2]) stages.push(m[2].toLowerCase());
  }
  if (!last || last === "scratch" || stages.includes(last.toLowerCase())) return null;
  return last;
}

/** A Docker Hub repository and tag for an image reference, or why it isn't watched. */
export function dockerHubRef(image: string): { repo: string; tag: string } | { error: string } {
  if (image.includes("$")) return { error: "the base image is set by a build argument" };
  if (image.includes("@")) return { error: "the base image is pinned by digest, so it only changes with a pull request" };
  let rest = image;
  const first = rest.split("/")[0]!;
  if (rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (first !== "docker.io" && first !== "registry-1.docker.io" && first !== "index.docker.io") return { error: `only Docker Hub base images are watched, not ${first}` };
    rest = rest.slice(first.length + 1);
  }
  const colon = rest.lastIndexOf(":");
  const name = colon > 0 ? rest.slice(0, colon) : rest;
  const tag = colon > 0 ? rest.slice(colon + 1) : "latest";
  return { repo: name.includes("/") ? name : `library/${name}`, tag };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/** The tag's current digest on Docker Hub, looked up at most once in BASE_FRESH for every package using it. */
async function hubDigest(env: Env, repo: string, tag: string, now: number): Promise<{ digest: string | null; error: string | null }> {
  const image = `${repo}:${tag}`;
  const cached = await env.DB.prepare(`SELECT * FROM base_images WHERE image = ?`).bind(image).first<{ digest: string | null; error: string | null; checked_at: number; changed_at: number | null }>();
  if (cached && cached.checked_at > now - BASE_FRESH) return { digest: cached.digest, error: cached.error };
  let digest: string | null = null;
  let error: string | null = null;
  try {
    const auth = await deps.fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`);
    if (!auth.ok) throw new Error(`Docker Hub's token service answered ${auth.status}`);
    const { token } = (await auth.json()) as { token: string };
    // A HEAD of the manifest doesn't count against Docker Hub's pull limit.
    const res = await deps.fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
      method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
    });
    if (!res.ok) throw new Error(`Docker Hub answered ${res.status} for ${image}`);
    digest = res.headers.get("docker-content-digest");
    if (!digest) throw new Error(`Docker Hub gave no digest for ${image}`);
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  // A failed lookup keeps the last digest known.
  const keep = digest ?? cached?.digest ?? null;
  await env.DB.prepare(
    `INSERT INTO base_images (image, digest, error, checked_at, changed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (image) DO UPDATE SET digest = excluded.digest, error = excluded.error, checked_at = excluded.checked_at,
       changed_at = CASE WHEN base_images.digest IS excluded.digest THEN base_images.changed_at ELSE excluded.changed_at END`,
  ).bind(image, keep, error, now, now).run();
  return { digest, error };
}

/** Records whether the package's base image changed since its latest version was first seen, and in rebuild mode acts on it. */
async function checkBaseImage(env: Env, t: Tool, token: string, now: number, opts: { nightly?: boolean }): Promise<BaseRow> {
  const prev = await env.DB.prepare(`SELECT * FROM base_watch WHERE tool_id = ?`).bind(t.id).first<BaseRow>();
  const sameVersion = prev?.pinned_version_id === t.latest_version_id;
  let image = sameVersion ? prev!.image : null;
  if (!sameVersion && t.git_sha) {
    const dockerfile = await github.fileAt(deps.fetch, token, t.wrapper!, "Dockerfile", t.git_sha).catch(() => null);
    image = dockerfile ? baseImage(dockerfile) : null;
  }
  const row: BaseRow = {
    tool_id: t.id, image, built_digest: sameVersion ? prev!.built_digest : null, latest_digest: null, pinned_version_id: t.latest_version_id,
    state: "unknown", error: null, rebuilt_at: prev?.rebuilt_at ?? null, checked_at: now, changed_at: prev?.changed_at ?? now,
  };
  if (!image) row.error = "no Dockerfile with a base image at the released commit";
  else {
    const ref = dockerHubRef(image);
    if ("error" in ref) row.error = ref.error;
    else {
      const d = await hubDigest(env, ref.repo, ref.tag, now);
      if (d.digest) {
        row.latest_digest = d.digest;
        row.built_digest ??= d.digest;
        row.state = row.built_digest === d.digest ? "current" : "updated";
      } else {
        row.state = "error";
        row.error = d.error;
      }
    }
  }
  if (!prev || prev.state !== row.state || prev.latest_digest !== row.latest_digest) row.changed_at = now;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO base_watch (tool_id, image, built_digest, latest_digest, pinned_version_id, state, error, rebuilt_at, checked_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.tool_id, row.image, row.built_digest, row.latest_digest, row.pinned_version_id, row.state, row.error, row.rebuilt_at, row.checked_at, row.changed_at).run();
  if (rebuildMode(env) === "rebuild" && opts.nightly) {
    await maybeRebuild(env, t, row, now).catch((e) => console.error("rebuilding on the newer base image failed", e));
  }
  return row;
}

/**
 * Rebuild mode: runs the release workflow again on unchanged source when the base image changed since the build and
 * the build's scan found fixable critical or high vulnerabilities; the new version's scan then shows whether the newer
 * base fixed them. Only for an active community-namespace package whose maintainers haven't turned off releases on
 * its own, with nothing else open or being released, main still at the released commit, at most every two weeks per
 * package and five a day.
 */
async function maybeRebuild(env: Env, t: Tool, row: BaseRow, now: number): Promise<boolean> {
  if (row.state !== "updated" || !row.latest_digest || !t.git_sha || !botConfigured(env)) return false;
  if (t.ns !== COMMUNITY_NAMESPACE || t.status !== "active" || !t.auto_release || (row.rebuilt_at ?? 0) > now - REBUILD_EVERY) return false;
  const vuln = await env.DB.prepare(`SELECT result FROM scans WHERE version_id = ? AND kind = 'vuln' ORDER BY ran_at DESC LIMIT 1`).bind(t.latest_version_id).first<{ result: string }>();
  if (vuln?.result !== "warn") return false;
  if (await env.DB.prepare(`SELECT 1 FROM bump_prs WHERE tool_id = ? AND status IN ('open', 'merged')`).bind(t.id).first()) return false;
  const token = await botToken(env);
  // Anything merged since the release would go out with it: leave that to the maintainers.
  if ((await github.branchHead(deps.fetch, token, t.wrapper!, "main")) !== t.git_sha) return false;
  if (await overLimit(env, "rebuild", "all", REBUILDS_PER_DAY, DAY, now)) return false;
  const version = `rebuild:${row.latest_digest.replace(/^sha256:/, "").slice(0, 12)}`;
  const released = await nextPatch(env, t.id, (JSON.parse(t.manifest_json) as { version: string }).version);
  const claim = await env.DB.prepare(
    `INSERT INTO bump_prs (tool_id, kind, version, pr_number, url, branch, status, released_version, auto, merge_sha, merged_at, attempts, created_at, updated_at)
     VALUES (?, 'rebuild', ?, 0, ?, 'main', 'merged', ?, 1, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(t.id, version, `https://github.com/${t.wrapper}/actions/workflows/${WORKFLOW}`, released, t.git_sha, now, now, now).run();
  // This digest was rebuilt before: a failed rebuild is the maintainers' to release again.
  if (!claim.meta.changes) return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE base_watch SET rebuilt_at = ? WHERE tool_id = ?`).bind(now, t.id),
    audit(env.DB, null, "system", "bump.rebuild", "tool", t.id, { image: row.image, digest: row.latest_digest, released }),
  ]);
  try {
    await github.dispatchWorkflow(deps.fetch, token, t.wrapper!, WORKFLOW, "main", { version: released });
  } catch (e) {
    await failBump(env, t.id, version, { code: "release_start_failed", message: `starting the rebuild failed: ${e instanceof Error ? e.message : String(e)}` });
    return false;
  }
  return true;
}

// ---------- the tool page ----------

/** What the tool page shows of a package's dependencies and base image. */
export const publicDependency = (r: DependencyRow) => ({ package: r.package, pinned: r.pinned, latest: r.latest, latest_at: r.latest_at, state: r.state });
export const publicBase = (r: BaseRow) => ({ image: r.image, state: r.state, checked_at: r.checked_at, rebuilt_at: r.rebuilt_at });
