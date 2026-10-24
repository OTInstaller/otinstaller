// Bump pull requests (UPSTREAM_WATCH=prs or auto): when the watcher finds a community wrapper behind a stable upstream
// release for three days, the community bot opens otinstaller/bump-<release> in the wrapper repository, changing only
// the pin: the Dockerfile's pin line, or for wheels the manifest's version, package_version and wheel_sha256. The
// package's maintainers (its submitter and others staff add, the namespace's members) and reviewers then merge and
// release it: the bot merges the pull request and starts the release, the release workflow for builds or a tag for
// wheels. A pull request that changes anything besides the pin needs a reviewer. With UPSTREAM_WATCH=auto the nightly
// check merges and releases a pin-only bump itself a week after upstream's release, unless the maintainers turned that
// off. Every attempt is followed to its end: released when the version is published, failed (and the maintainers told)
// when the build, validation or scan didn't publish it; a failed bump can be released again. The same machinery
// releases the first-party tools' dependency updates and rebuilds on a newer base image (build-watch.ts), told apart
// by `kind`. The table is in migrations 0022, 0028 and 0031.
import { deps, type Env, type User } from "./env";
import { apiError } from "./lib/errors";
import { semverParts } from "./lib/manifest";
import * as github from "./hosts/github";
import { HostError } from "./hosts/github";
import { pypiRelease } from "./hosts/artifacts";
import { audit } from "./routes/auth";
import { closeSystemIssue, communityRoles, isMember } from "./community";
import { maintainers, notify } from "./inbox";
import { COMMUNITY_NAMESPACE, isRedistributable } from "./imports";
import { botConfigured, botToken } from "./submissions";
import { overLimit } from "./trust";
import { findPin, isCommitPin } from "./upstream-pin";
import { ISSUE_AFTER, type WatchRow } from "./upstream";

export type BumpStatus = "open" | "merged" | "released" | "failed" | "closed";
/** upstream: a wrapper's pin; dependency: a first-party tool's requirements.txt; rebuild: the same source on a newer base image. */
export type BumpKind = "upstream" | "dependency" | "rebuild";

export type BumpRow = {
  tool_id: string; kind: BumpKind; version: string; pr_number: number; url: string; branch: string; status: BumpStatus; released_version: string | null;
  merged_by: string | null; auto: number; merge_sha: string | null; merged_at: number | null; run_url: string | null; attempts: number;
  error_code: string | null; error: string | null; released_at: number | null; created_at: number; updated_at: number;
};

export type Tool = { id: string; name: string; ns: string; namespace_id: string; upstream_url: string | null; wrapper: string | null; manifest_json: string };

export const WORKFLOW = "otinstaller-release.yml";
export const DAY = 86_400_000;
/** A bump goes out on its own (UPSTREAM_WATCH=auto) a week after upstream's release, and no sooner than this after its pull request opened. */
export const AUTO_AFTER = 7 * DAY;
export const AUTO_PR_AGE = 4 * DAY;
/** How many bumps the registry releases on its own in a day, across every wrapper. */
export const AUTO_PER_DAY = 10;
/** A release that hasn't reached the registry by then has failed somewhere the registry can't see. */
const RELEASE_WAIT = 12 * 3_600_000;

const plain = (v: string) => v.replace(/^v/, "");

/** The pinned reference written the way the old one was (with or without a leading v). */
const styled = (old: string, next: string) => (old.startsWith("v") ? `v${plain(next)}` : plain(next));

/** Pin kinds a bump can change: one line of a Dockerfile, or a wheel in the manifest. */
const BUMPABLE = new Set(["arg", "go", "pip", "pip_git", "git", "cargo", "cargo_git", "release_url", "raw_url", "pipx"]);

// ---------- versions ----------

/**
 * Upstream's release as a stable X.Y.Z: 2.2 is 2.2.0, 20250130 is 20250130.0.0, 2026.08.19 is 2026.8.19, and a fourth
 * part or a .postN is dropped (a later patch on top keeps the version new). Null for a prerelease or anything that
 * isn't a release number: those never get a bump.
 */
export function upstreamSemver(v: string): string | null {
  const m = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:\.\d{1,9})?(?:\.post\d+)?$/i.exec(v.trim());
  if (!m) return null;
  return [m[1]!, m[2] ?? "0", m[3] ?? "0"].map((x) => String(Number(x))).join(".");
}

/** Compares two X.Y.Z versions (a prerelease part is ignored). */
export function compareSemver(a: string, b: string): number {
  const x = semverParts(a);
  const y = semverParts(b);
  return Math.sign(x.major - y.major || x.minor - y.minor || x.patch - y.patch);
}

/**
 * The version a bump to upstream's `latest` releases: upstream's own number when it is above every version the package
 * ever had (any status) and every version a bump released, otherwise a patch on top of the highest of those.
 */
export async function wrapperVersion(env: Env, toolId: string, latest: string): Promise<string | null> {
  const want = upstreamSemver(latest);
  if (!want) return null;
  const highest = await highestVersion(env, toolId);
  if (!highest || compareSemver(want, highest) > 0) return want;
  const p = semverParts(highest);
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** The highest version the package ever had (any status) or a bump released. */
async function highestVersion(env: Env, toolId: string): Promise<string | null> {
  const rows = (await env.DB.prepare(
    `SELECT version FROM versions WHERE tool_id = ? UNION SELECT released_version FROM bump_prs WHERE tool_id = ? AND released_version IS NOT NULL`,
  ).bind(toolId, toolId).all<{ version: string }>()).results.map((r) => r.version).filter((v) => /^\d+\.\d+\.\d+(-.+)?$/.test(v));
  return rows.reduce<string | null>((h, v) => (!h || compareSemver(v, h) > 0 ? v : h), null);
}

/** A patch on top of every version the package had: what a dependency update or a rebuild releases. */
export async function nextPatch(env: Env, toolId: string, fallback: string): Promise<string> {
  const p = semverParts((await highestVersion(env, toolId)) ?? fallback);
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** How a bump is named in notices: the bump to v1.3.0, the dependency update (dnspython 2.9.0), the rebuild. */
export function bumpLabel(b: Pick<BumpRow, "kind" | "version">): string {
  if (b.kind === "dependency") return `the dependency update (${b.version.replaceAll("==", " ").replaceAll(",", ", ")})`;
  if (b.kind === "rebuild") return "the rebuild on a newer base image";
  return `the bump to ${b.version}`;
}

// ---------- opening ----------

export async function openBumpFor(env: Env, toolId: string): Promise<BumpRow | null> {
  return env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).bind(toolId).first<BumpRow>();
}

/** The bump a package page shows: an open, started or failed one, or one released in the last two weeks. */
export async function currentBump(env: Env, toolId: string, now = Date.now()): Promise<BumpRow | null> {
  return env.DB.prepare(
    `SELECT * FROM bump_prs WHERE tool_id = ? AND (status IN ('open', 'merged', 'failed') OR (status = 'released' AND released_at > ?))
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(toolId, now - 14 * DAY).first<BumpRow>();
}

/** When an open bump goes out on its own in auto mode: a week after upstream's release, and four days after it opened. */
export function autoReleaseAt(w: Pick<WatchRow, "latest_at">, bump: Pick<BumpRow, "created_at">): number {
  return Math.max((w.latest_at ?? bump.created_at) + AUTO_AFTER, bump.created_at + AUTO_PR_AGE);
}

/** The one file a bump changes, with its new content, worked out from the wrapper's main branch; null when it can't be. */
async function planBump(env: Env, token: string, t: Tool, w: WatchRow): Promise<github.FileChange | null> {
  const latest = w.latest!;
  if (w.pin_kind === "pipx") {
    const m = JSON.parse(t.manifest_json) as { runtime?: { package?: string } };
    const wheel = m.runtime?.package ? await pypiRelease(deps.fetch, m.runtime.package, plain(latest)) : null;
    const version = await wrapperVersion(env, t.id, latest);
    if (!wheel?.wheelSha256 || !version) return null;
    const yaml = await github.fileAt(deps.fetch, token, t.wrapper!, "otinstaller.yaml", "main");
    if (!yaml) return null;
    const next = yaml
      .replace(/^version:\s*["']?[^\s"'#]+["']?/m, `version: ${version}`)
      .replace(/^(\s+package_version:\s*)["']?[^\s"'#]+["']?/m, `$1"${plain(latest)}"`)
      .replace(/^(\s+wheel_sha256:\s*)["']?[0-9a-f]{64}["']?/m, `$1${wheel.wheelSha256}`);
    return next === yaml ? null : { path: "otinstaller.yaml", content: next };
  }
  const dockerfile = await github.fileAt(deps.fetch, token, t.wrapper!, "Dockerfile", "main");
  const pin = dockerfile && t.upstream_url ? findPin(dockerfile, t.upstream_url) : null;
  if (!dockerfile || !pin) return null;
  // Main pins what the published version pins, or what a merged bump whose release failed pinned.
  if (pin.ref !== w.pinned) {
    const tried = await env.DB.prepare(
      `SELECT version FROM bump_prs WHERE tool_id = ? AND status IN ('merged', 'failed') ORDER BY created_at DESC LIMIT 1`,
    ).bind(t.id).first<{ version: string }>();
    if (!tried || plain(tried.version) !== plain(pin.ref) || plain(pin.ref) === plain(latest)) return null;
  }
  const lines = dockerfile.split("\n");
  // The pin's instruction may continue over several lines; change the first one that names the pin.
  const i = lines.findIndex((l, n) => n >= pin.line - 1 && l.includes(pin.ref));
  if (i < 0) return null;
  lines[i] = lines[i]!.replace(pin.ref, styled(pin.ref, pin.kind === "pip" || pin.kind === "cargo" || pin.kind === "arg" ? plain(latest) : latest));
  return { path: "Dockerfile", content: lines.join("\n") };
}

/**
 * Opens the bump pull request for what the watcher just found, once: only for a stable release (never commits), three
 * days after it came out, when the pin can be changed in one place, and when the community bot is set up. Older bumps
 * that never went in are closed, on GitHub too.
 */
export async function maybeOpenBump(env: Env, t: Tool, w: WatchRow, now = Date.now()): Promise<BumpRow | null> {
  if (!botConfigured(env) || w.state !== "behind" || !w.latest || !w.pinned || !w.pin_kind || !t.wrapper) return null;
  if (!BUMPABLE.has(w.pin_kind) || w.commits_behind || isCommitPin({ kind: "git", ref: w.pinned, line: 0 }) || (w.latest_at ?? 0) > now - ISSUE_AFTER) return null;
  if (!upstreamSemver(w.latest)) return null;
  const existing = await env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, w.latest).first<BumpRow>();
  if (existing) return existing;
  const token = await botToken(env);
  const latest = w.latest;
  const file = await planBump(env, token, t, w);
  if (!file) return null;
  const branch = `otinstaller/bump-${plain(latest)}`;
  const title = `Bump ${t.name} to ${latest}`;
  const body = `${w.upstream_path} released **${latest}**; this package pins ${w.pinned}. This changes only the pin (\`${file.path}\`).\n\n` +
    `A maintainer of ${t.ns}/${t.name} can merge and release it from the package's page on otinstaller.com; the release is built, signed and scanned like any other.`;
  let pr: { url: string; number: number };
  try {
    pr = await github.openPullRequest(deps.fetch, token, t.wrapper, "main", branch, [file], title, body);
  } catch (e) {
    if (e instanceof HostError) return (console.error("opening the bump pull request failed", e), null);
    throw e;
  }
  const older = (await env.DB.prepare(`SELECT pr_number FROM bump_prs WHERE tool_id = ? AND kind = 'upstream' AND status = 'open' AND version != ?`).bind(t.id, latest).all<{ pr_number: number }>()).results;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO bump_prs (tool_id, version, pr_number, url, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(t.id, latest, pr.number, pr.url, branch, now, now),
    // An older bump that never went in is superseded by this one.
    env.DB.prepare(`UPDATE bump_prs SET status = 'closed', updated_at = ? WHERE tool_id = ? AND kind = 'upstream' AND status IN ('open', 'failed') AND version != ?`).bind(now, t.id, latest),
    audit(env.DB, null, "system", "bump.open", "tool", t.id, { version: latest, pr: pr.url }),
  ]);
  for (const o of older) {
    if (o.pr_number !== pr.number) await github.closePull(deps.fetch, token, t.wrapper, o.pr_number).catch((e) => console.error("closing a superseded bump failed", e));
  }
  return env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, latest).first<BumpRow>();
}

// ---------- releasing ----------

/** Whether someone may merge and release a package's pin-only bumps: its maintainers, namespace members and reviewers. */
export async function canRelease(env: Env, user: User | null, t: Pick<Tool, "id" | "namespace_id">): Promise<{ maintainer: boolean; reviewer: boolean }> {
  if (!user) return { maintainer: false, reviewer: false };
  const reviewer = (await communityRoles(env, user)).has("reviewer");
  const listed = !!(await env.DB.prepare(`SELECT 1 FROM tool_maintainers WHERE tool_id = ? AND user_id = ?`).bind(t.id, user.id).first());
  return { maintainer: listed || (await isMember(env, t.namespace_id, user.id)), reviewer };
}

/**
 * Whether a pull request's changes are the pin alone: one line of the Dockerfile, the manifest's version fields, or
 * requirements.txt's exact pins (the same packages before and after, only their versions changed).
 */
export function pinOnly(files: { filename: string; patch?: string }[]): boolean {
  if (files.length !== 1 || !files[0]!.patch) return false;
  const changed = files[0]!.patch.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
  if (files[0]!.filename === "Dockerfile") return changed.length === 2 && changed[0]!.startsWith("-") && changed[1]!.startsWith("+");
  if (files[0]!.filename === "otinstaller.yaml") return changed.length > 0 && changed.every((l) => /^[-+]\s*(version|package_version|wheel_sha256):/.test(l));
  if (files[0]!.filename === "requirements.txt") {
    // Each line is an exact pin, and the lines read the same before and after with their versions left out.
    const pin = /^[-+][A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)\s*(?:;.*)?$/;
    if (!changed.length || changed.some((l) => !pin.test(l))) return false;
    const rest = (side: string) => changed.filter((l) => l[0] === side).map((l) => l.slice(1).replace(/==\s*[A-Za-z0-9.!+_-]+/, "==").toLowerCase()).sort().join("\n");
    return rest("-") === rest("+");
  }
  return false;
}

/** A person merges and releases a bump, or releases a failed one again. A change beyond the pin needs a reviewer. */
export async function releaseBumpAs(env: Env, actor: User, t: Tool, number: number): Promise<{ version: string; released: string; attempt: number }> {
  const who = await canRelease(env, actor, t);
  if (!who.maintainer && !who.reviewer) apiError(403, "not_package_maintainer", "only the package's maintainers and reviewers can merge and release a bump");
  // A rebuild has no pull request: it is #0, and only ever released again after it failed.
  const bump = await env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND pr_number = ? ORDER BY created_at DESC LIMIT 1`).bind(t.id, number).first<BumpRow>();
  if (!bump || !t.wrapper || bump.status === "released" || bump.status === "closed") apiError(404, "bump_not_found", `${t.ns}/${t.name} has no open or failed bump pull request #${number}`);
  if (bump.status === "merged") apiError(409, "bump_in_progress", `the release of ${bump.released_version ?? "this bump"} is under way`, "wait for it to be published or to fail");
  if (bump.status === "open") {
    const token = await botToken(env);
    if (!pinOnly(await github.pullFiles(deps.fetch, token, t.wrapper, number)) && !who.reviewer) {
      apiError(403, "not_pin_only", "the pull request changes more than the pin, so a reviewer merges it");
    }
  }
  return releaseBump(env, t, bump, { actorId: actor.id, auto: false });
}

/**
 * Merges an open bump (once) and starts its release, or starts a failed bump's release again without merging: the
 * release workflow builds upstream's release, or a tag publishes the bumped manifest. Permission checks are the
 * caller's: releaseBumpAs for people, maybeAutoRelease for the registry.
 */
export async function releaseBump(env: Env, t: Tool, bump: BumpRow, by: { actorId: string | null; auto: boolean }): Promise<{ version: string; released: string; attempt: number }> {
  const db = env.DB;
  const now = Date.now();
  const token = await botToken(env);
  const wrapper = t.wrapper!;
  // The status moves first, so two clicks (or a click and the nightly check) never merge or release twice.
  const claim = await db.prepare(
    `UPDATE bump_prs SET status = 'merged', merged_at = ?, merged_by = COALESCE(?, merged_by), auto = ?, attempts = attempts + 1,
       error_code = NULL, error = NULL, run_url = NULL, updated_at = ?
     WHERE tool_id = ? AND version = ? AND status = ?`,
  ).bind(now, by.actorId, by.auto ? 1 : 0, now, t.id, bump.version, bump.status).run();
  if (!claim.meta.changes) apiError(409, "bump_in_progress", "someone else is releasing this bump", "reload the package page");
  let sha = bump.merge_sha;
  if (bump.status === "open") {
    try {
      sha = await github.mergePull(deps.fetch, token, wrapper, bump.pr_number, bump.kind === "dependency" ? `Update ${t.name}'s dependencies` : `Bump ${t.name} to ${bump.version}`);
    } catch (e) {
      await db.prepare(`UPDATE bump_prs SET status = 'open', merged_at = NULL, attempts = attempts - 1, updated_at = ? WHERE tool_id = ? AND version = ?`).bind(now, t.id, bump.version).run();
      if (e instanceof HostError) apiError(409, "bump_not_mergeable", `GitHub won't merge #${bump.pr_number}: ${e.message}`, "resolve it on GitHub, or ask a reviewer");
      throw e;
    }
    await db.prepare(`UPDATE bump_prs SET merge_sha = ? WHERE tool_id = ? AND version = ?`).bind(sha, t.id, bump.version).run();
  }
  const m = JSON.parse(t.manifest_json) as { version: string; runtime?: { kind?: string } };
  const released = (bump.kind === "upstream" ? await wrapperVersion(env, t.id, bump.version) : null) ?? (await nextPatch(env, t.id, m.version));
  try {
    if (m.runtime?.kind === "pipx") {
      // The tag must match the manifest's version: a release again needs a new version on main first.
      const yaml = await github.fileAt(deps.fetch, token, wrapper, "otinstaller.yaml", "main");
      if (yaml && !new RegExp(`^version:\\s*["']?${released.replace(/\./g, "\\.")}["']?\\s*$`, "m").test(yaml)) {
        await github.putFile(deps.fetch, token, wrapper, "main", { path: "otinstaller.yaml", content: yaml.replace(/^version:\s*["']?[^\s"'#]+["']?/m, `version: ${released}`) }, `Release ${released}`);
        sha = await github.branchHead(deps.fetch, token, wrapper, "main");
      }
      await github.createTag(deps.fetch, token, wrapper, `v${released}`, sha ?? (await github.branchHead(deps.fetch, token, wrapper, "main")));
    } else {
      await github.dispatchWorkflow(deps.fetch, token, wrapper, WORKFLOW, "main", { version: released });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await failBump(env, t.id, bump.version, { code: "release_start_failed", message: `starting the release failed: ${message}` });
    if (e instanceof HostError) apiError(503, "github_failed", `${bump.kind === "rebuild" ? "starting the rebuild" : `the pull request is merged, but starting the release`} of ${released} failed: ${message}`, "try again from the package page");
    throw e;
  }
  const attempt = bump.attempts + 1;
  await db.batch([
    db.prepare(`UPDATE bump_prs SET released_version = ?, updated_at = ? WHERE tool_id = ? AND version = ?`).bind(released, Date.now(), t.id, bump.version),
    audit(db, by.actorId, by.actorId ? "user" : "system", by.auto ? "bump.auto_release" : "bump.release", "tool", t.id, { pr: bump.pr_number, version: bump.version, released, attempt }),
  ]);
  return { version: bump.version, released, attempt };
}

/** The package's maintainers hear that a bump's release didn't make it, and why. */
export async function failBump(env: Env, toolId: string, version: string, why: { code: string; message: string; runUrl?: string }) {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE bump_prs SET status = 'failed', error_code = ?, error = ?, run_url = ?, updated_at = ? WHERE tool_id = ? AND version = ? AND status = 'merged'`,
  ).bind(why.code, why.message.slice(0, 500), why.runUrl ?? null, now, toolId, version).run();
  if (!res.meta.changes) return;
  const t = await env.DB.prepare(
    `SELECT t.name, n.name AS ns, t.namespace_id, b.kind FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN bump_prs b ON b.tool_id = t.id AND b.version = ? WHERE t.id = ?`,
  ).bind(version, toolId).first<{ name: string; ns: string; namespace_id: string; kind: BumpKind }>();
  if (!t) return;
  await notify(env, await maintainers(env, t.namespace_id, toolId), {
    kind: "status", scope: "owner_issues", path: `/${t.ns}/${t.name}`, tool_id: toolId,
    summary: `${t.ns}/${t.name}: the release of ${bumpLabel({ kind: t.kind, version })} failed (${why.code}); release it again from the package page once it's fixed`,
  });
}

/**
 * Settles a started bump once its release ends: published (and its outdated issue closed), or failed with the reason
 * the publish job or scan gave. Called when a version is published or rejected, and by the 15-minute sweep.
 */
export async function settleBump(env: Env, toolId: string, version: string, outcome: "released" | { code: string; message: string; runUrl?: string }) {
  const bump = await env.DB.prepare(`SELECT kind, version FROM bump_prs WHERE tool_id = ? AND released_version = ? AND status = 'merged'`).bind(toolId, version).first<{ kind: BumpKind; version: string }>();
  if (!bump) return;
  if (outcome !== "released") return failBump(env, toolId, bump.version, outcome);
  const now = Date.now();
  await env.DB.prepare(`UPDATE bump_prs SET status = 'released', released_at = ?, updated_at = ? WHERE tool_id = ? AND version = ? AND status = 'merged'`)
    .bind(now, now, toolId, bump.version).run();
  // Its issues close: the upstream release's outdated issue, or each updated dependency's.
  const keys = bump.kind === "upstream" ? [`outdated:${bump.version}`] : bump.kind === "dependency" ? bump.version.split(",").map((p) => `dependency:${p}`) : [];
  for (const key of keys) {
    await closeSystemIssue(env, toolId, key, "fixed", `Version ${version}, which pins ${key.replace(/^(outdated|dependency):/, "").replace("==", " ")}, is published.`)
      .catch((e) => console.error("closing the outdated issue failed", e));
  }
}

/**
 * Every 15 minutes: follows the bumps whose release started. Published versions settle them as released; a rejected
 * version or publish job, a failed release workflow run, or nothing arriving within 12 hours settles them as failed.
 */
export async function sweepBumps(env: Env, now = Date.now()) {
  const rows = (await env.DB.prepare(
    `SELECT b.*, s.path AS wrapper, json_extract(v.manifest_json, '$.runtime.kind') AS runtime
     FROM bump_prs b JOIN tools t ON t.id = b.tool_id LEFT JOIN sources s ON s.tool_id = b.tool_id LEFT JOIN versions v ON v.id = t.latest_version_id
     WHERE b.status = 'merged' AND b.released_version IS NOT NULL ORDER BY b.merged_at LIMIT 20`,
  ).all<BumpRow & { wrapper: string | null; runtime: string | null }>()).results;
  let token: string | null = null;
  for (const b of rows) {
    const version = b.released_version!;
    const v = await env.DB.prepare(`SELECT status, rejected_reason FROM versions WHERE tool_id = ? AND version = ?`).bind(b.tool_id, version).first<{ status: string; rejected_reason: string | null }>();
    if (v && (v.status === "published" || v.status === "yanked")) {
      await settleBump(env, b.tool_id, version, "released");
      continue;
    }
    if (v?.status === "rejected") {
      await settleBump(env, b.tool_id, version, { code: v.rejected_reason ?? "rejected", message: `version ${version} was rejected (${v.rejected_reason ?? "see its security page"})` });
      continue;
    }
    const job = await env.DB.prepare(
      `SELECT j.status, j.error_code, j.error_detail FROM publish_jobs j
       WHERE (j.tool_id = ? OR j.source_id = (SELECT id FROM sources WHERE tool_id = ?)) AND j.tag = ? AND j.created_at >= ?
       ORDER BY j.created_at DESC LIMIT 1`,
    ).bind(b.tool_id, b.tool_id, `v${version}`, b.merged_at ?? 0).first<{ status: string; error_code: string | null; error_detail: string | null }>();
    if (job && (job.status === "rejected" || job.status === "error")) {
      await settleBump(env, b.tool_id, version, { code: job.error_code ?? "publish_failed", message: job.error_detail ?? `the release of ${version} was not published` });
      continue;
    }
    if (job) continue;
    // Nothing reached the registry yet: a build may have failed before it tagged.
    if (b.runtime === "docker" && b.wrapper && botConfigured(env) && (b.merged_at ?? 0) < now - 30 * 60_000) {
      try {
        token ??= await botToken(env);
        const runs = await github.workflowRuns(deps.fetch, token, b.wrapper, WORKFLOW, (b.merged_at ?? now) - 60_000);
        const done = runs.find((r) => r.status === "completed");
        if (done && done.conclusion !== "success" && !runs.some((r) => r.status !== "completed" && r.created_at > done.created_at)) {
          await settleBump(env, b.tool_id, version, { code: "release_workflow_failed", message: `the release workflow ended ${done.conclusion ?? "without finishing"}`, runUrl: done.url });
          continue;
        }
      } catch (e) {
        console.error("reading the release workflow's runs failed", e);
      }
    }
    if ((b.merged_at ?? 0) < now - RELEASE_WAIT) {
      await settleBump(env, b.tool_id, version, { code: "release_not_received", message: `no release of ${version} reached the registry within 12 hours` });
    }
  }
  return rows.length;
}

// ---------- releasing on its own (UPSTREAM_WATCH=auto) ----------

/**
 * Auto mode: the nightly check merges and releases an open bump itself when every one of these holds. Upstream's
 * release is stable and the date from autoReleaseAt has passed; the wrapper is still behind it, under its license that
 * the registry may redistribute; the package lives in the community namespace and its maintainers haven't turned this
 * off; the pull request is still open and changes exactly the planned file; and fewer than ten bumps went out today.
 */
export async function maybeAutoRelease(env: Env, t: Tool, w: WatchRow, bump: BumpRow | null, now = Date.now()): Promise<boolean> {
  if (!bump || bump.kind !== "upstream" || bump.status !== "open" || !t.wrapper || !w.latest || bump.version !== w.latest) return false;
  if (w.state !== "behind" || !upstreamSemver(w.latest) || !isRedistributable(w.upstream_license) || now < autoReleaseAt(w, bump)) return false;
  if (t.ns !== COMMUNITY_NAMESPACE || !t.wrapper.startsWith(`${COMMUNITY_NAMESPACE}/`)) return false;
  const tool = await env.DB.prepare(`SELECT auto_release, status FROM tools WHERE id = ?`).bind(t.id).first<{ auto_release: number; status: string }>();
  if (!tool?.auto_release || tool.status !== "active") return false;
  const token = await botToken(env);
  const pr = await github.getPull(deps.fetch, token, t.wrapper, bump.pr_number);
  if (pr.state !== "open") {
    // Closed or merged on GitHub: a person decided; the registry doesn't release it.
    await env.DB.prepare(`UPDATE bump_prs SET status = 'closed', updated_at = ? WHERE tool_id = ? AND version = ? AND status = 'open'`).bind(now, t.id, bump.version).run();
    return false;
  }
  const planned = await planBump(env, token, t, w);
  const onBranch = planned ? await github.fileAt(deps.fetch, token, t.wrapper, planned.path, bump.branch) : null;
  const files = await github.pullFiles(deps.fetch, token, t.wrapper, bump.pr_number);
  if (!planned || onBranch !== planned.content || files.length !== 1 || files[0]!.filename !== planned.path || !pinOnly(files)) return false;
  if (await overLimit(env, "auto_release", "all", AUTO_PER_DAY, DAY, now)) return false;
  await releaseBump(env, t, bump, { actorId: null, auto: true });
  return true;
}
