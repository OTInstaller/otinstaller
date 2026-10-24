// The upstream watcher: nightly, for each community wrapper, which upstream release its latest version pins (read
// from its Dockerfile by upstream-pin.ts, its pinned wheel, or a staff override) and what upstream has released since.
// Each check makes at most three requests through deps.fetch: the repository (archived, gone, renamed, license), its
// latest release (with an ETag, so an unchanged answer is a free 304) or PyPI, and the Dockerfile only when the
// package has a new version (or the compare API for commit pins). UPSTREAM_WATCH decides what happens with a
// difference: "report" (the default) only records it, "issues" also opens and closes outdated issues, "prs" also has
// the community bot open a pull request bumping the pin, and "auto" also merges and releases pin-only bumps a week
// after upstream's release (bumps.ts). Routes live in routes/upstream.ts; the table is in migration 0021.
import { deps, requireSecret, type Env } from "./env";
import * as github from "./hosts/github";
import { COMMUNITY_NAMESPACE, isRedistributable, parseRepoRef } from "./imports";
import { closeSystemIssue, fileSystemIssue } from "./community";
import { notify } from "./inbox";
import { findPin, isCommitPin, type Pin } from "./upstream-pin";
import { autoReleaseAt, maybeAutoRelease, maybeOpenBump, type BumpRow } from "./bumps";

export type WatchState = "current" | "behind" | "unknown" | "archived" | "gone" | "license_changed" | "renamed" | "error";
export type WatchMode = "report" | "issues" | "prs" | "auto";

export type WatchRow = {
  tool_id: string; provider: "github" | "gitlab" | null; upstream_path: string | null; pin_kind: string | null; pinned: string | null;
  pin_package: string | null; pinned_version_id: string | null; latest: string | null; latest_at: number | null; commits_behind: number | null; state: WatchState;
  upstream_license: string | null; releases_etag: string | null; override_json: string | null; error: string | null; checked_at: number | null;
  changed_at: number | null;
};

/** What the watcher does with what it finds; anything but "issues", "prs" or "auto" means report only. */
export const watchMode = (env: Env): WatchMode =>
  env.UPSTREAM_WATCH === "issues" || env.UPSTREAM_WATCH === "prs" || env.UPSTREAM_WATCH === "auto" ? env.UPSTREAM_WATCH : "report";

/** An outdated issue waits this long after upstream's release, so a wrapper bumped the same week never gets one. */
export const ISSUE_AFTER = 3 * 86_400_000;

/** Compares two release names loosely (v1.2.3, 1.2, 2.0.0-rc1); null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (s: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:[-+.]?([0-9A-Za-z.-]+))?$/.exec(s.trim());
    return m ? { nums: m[1]!.split(".").map(Number), pre: m[2] ?? "" } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  // A prerelease comes before its release.
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return x.pre === y.pre ? 0 : x.pre < y.pre ? -1 : 1;
}

/** Queues a check of every published community wrapper; runs nightly. */
export async function queueUpstreamChecks(env: Env) {
  const tools = (await env.DB.prepare(
    `SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     WHERE n.name = ? AND t.community_packaged = 1 AND t.upstream_url IS NOT NULL AND t.status != 'removed' AND t.latest_version_id IS NOT NULL`,
  ).bind(COMMUNITY_NAMESPACE).all<{ id: string }>()).results;
  for (let i = 0; i < tools.length; i += 100) {
    await env.PUBLISH_QUEUE.sendBatch(tools.slice(i, i + 100).map((t) => ({ body: { upstreamCheckToolId: t.id } })));
  }
  return tools.length;
}

/** The registry App's token on osintverse-community (it can read public repositories), else none. */
export async function readToken(env: Env): Promise<string> {
  const inst = await env.DB.prepare(
    `SELECT i.github_installation_id FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE n.name = ? AND i.suspended_at IS NULL LIMIT 1`,
  ).bind(COMMUNITY_NAMESPACE).first<{ github_installation_id: number }>();
  if (!inst || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_ID) return "";
  return github.installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), inst.github_installation_id).catch(() => "");
}

const ghHeaders = (token: string, extra: Record<string, string> = {}) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "otinstaller-registry", ...extra,
});

type Repo = { state: WatchState | null; license: string | null; branch: string; error?: string };

/** The upstream repository: gone, renamed, archived, or whose license no longer allows redistribution. */
async function repoState(provider: "github" | "gitlab", path: string, token: string): Promise<Repo> {
  if (provider === "gitlab") {
    const res = await deps.fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}?license=true`);
    if (res.status === 404) return { state: "gone", license: null, branch: "main" };
    if (!res.ok) return { state: "error", license: null, branch: "main", error: `GitLab answered ${res.status}` };
    const p = (await res.json()) as { path_with_namespace: string; archived: boolean; default_branch?: string; license?: { key?: string } | null };
    const renamed = p.path_with_namespace.toLowerCase() !== path.toLowerCase();
    return { state: renamed ? "renamed" : p.archived ? "archived" : null, license: p.license?.key ?? null, branch: p.default_branch ?? "main" };
  }
  const res = await deps.fetch(`https://api.github.com/repos/${path}`, { headers: ghHeaders(token) });
  if (res.status === 404) return { state: "gone", license: null, branch: "main" };
  if (!res.ok) return { state: "error", license: null, branch: "main", error: `GitHub answered ${res.status}` };
  const r = (await res.json()) as { full_name: string; archived: boolean; default_branch: string; license?: { spdx_id?: string | null } | null };
  const license = r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null;
  const renamed = r.full_name.toLowerCase() !== path.toLowerCase();
  return {
    state: renamed ? "renamed" : r.archived ? "archived" : license && !isRedistributable(license) ? "license_changed" : null,
    license, branch: r.default_branch,
  };
}

/** Upstream's latest release name and date: PyPI for wheels, else the latest GitHub/GitLab release or highest tag. */
async function latestRelease(provider: "github" | "gitlab", path: string, token: string, pin: Pin | { kind: string; ref: string; package?: string }, etag: string | null) {
  if ((pin.kind === "pipx" || pin.kind === "pip") && pin.package) {
    const res = await deps.fetch(`https://pypi.org/pypi/${encodeURIComponent(pin.package)}/json`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { error: `PyPI answered ${res.status} for ${pin.package}` };
    const body = (await res.json()) as { info: { version: string }; releases?: Record<string, { upload_time_iso_8601?: string }[]> };
    const at = body.releases?.[body.info.version]?.[0]?.upload_time_iso_8601;
    return { latest: body.info.version, latest_at: at ? Date.parse(at) : null };
  }
  if (provider === "gitlab") {
    const res = await deps.fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/releases?per_page=1`);
    if (!res.ok) return { error: `GitLab answered ${res.status}` };
    const rel = ((await res.json()) as { tag_name: string; released_at?: string }[])[0];
    return rel ? { latest: rel.tag_name, latest_at: rel.released_at ? Date.parse(rel.released_at) : null } : { latest: null, latest_at: null };
  }
  const res = await deps.fetch(`https://api.github.com/repos/${path}/releases/latest`, { headers: ghHeaders(token, etag ? { "If-None-Match": etag } : {}) });
  if (res.status === 304) return { unchanged: true as const };
  if (res.ok) {
    const r = (await res.json()) as { tag_name: string; published_at?: string | null };
    return { latest: r.tag_name, latest_at: r.published_at ? Date.parse(r.published_at) : null, etag: res.headers.get("etag") };
  }
  if (res.status !== 404) return { error: `GitHub answered ${res.status} for the latest release` };
  // No releases: the highest version among the tags.
  const tags = await deps.fetch(`https://api.github.com/repos/${path}/tags?per_page=100`, { headers: ghHeaders(token) });
  if (!tags.ok) return { error: `GitHub answered ${tags.status} for the tags` };
  const names = ((await tags.json()) as { name: string }[]).map((t) => t.name).filter((n) => compareVersions(n, n) !== null);
  names.sort((a, b) => compareVersions(b, a) ?? 0);
  return { latest: names[0] ?? null, latest_at: null };
}

/** The pin of the tool's latest version: a staff override, the wheel it pins, its Dockerfile, or upstream's own image. */
async function currentPin(t: Tool, prev: WatchRow | null, token: string): Promise<{ kind: string; ref: string; package?: string } | null> {
  if (prev?.override_json) {
    const o = JSON.parse(prev.override_json) as { pin_kind: string; pinned: string; package?: string };
    return { kind: o.pin_kind, ref: o.pinned, package: o.package };
  }
  const m = JSON.parse(t.manifest_json) as { version: string; runtime?: { kind?: string; image?: string; package?: string; package_version?: string } };
  if (m.runtime?.kind === "pipx" && m.runtime.package_version) return { kind: "pipx", ref: m.runtime.package_version, package: m.runtime.package };
  // A Dockerfile only changes with a new version, so it is read again only then.
  if (prev?.pinned_version_id === t.latest_version_id && prev.pin_kind && prev.pinned && prev.pin_kind !== "none") {
    return { kind: prev.pin_kind, ref: prev.pinned, package: prev.pin_package ?? undefined };
  }
  if (t.wrapper && t.git_sha) {
    const dockerfile = await github.fileAt(deps.fetch, token, t.wrapper, "Dockerfile", t.git_sha).catch(() => null);
    if (dockerfile) return findPin(dockerfile, t.upstream_url);
  }
  // No Dockerfile: the wrapper pins upstream's own image, released as the same version.
  if (m.runtime?.kind === "docker" && m.runtime.image && !m.runtime.image.startsWith(`ghcr.io/${COMMUNITY_NAMESPACE}/`)) return { kind: "image", ref: m.version };
  return null;
}

type Tool = {
  id: string; name: string; ns: string; upstream_url: string; latest_version_id: string; manifest_json: string; git_sha: string | null; wrapper: string | null;
  namespace_id: string;
};

/**
 * Checks one wrapper against its upstream and records the result (and, outside report mode, acts on it). Only the
 * nightly check releases a bump on its own in auto mode; a staff member's "Check now" never does.
 */
export async function checkUpstream(env: Env, toolId: string, now = Date.now(), opts: { nightly?: boolean } = {}): Promise<WatchRow | null> {
  const t = await env.DB.prepare(
    `SELECT t.id, t.name, n.name AS ns, t.namespace_id, t.upstream_url, t.latest_version_id, v.manifest_json, v.git_sha, s.path AS wrapper
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id LEFT JOIN sources s ON s.tool_id = t.id
     WHERE t.id = ? AND t.status != 'removed' AND t.upstream_url IS NOT NULL`,
  ).bind(toolId).first<Tool>();
  if (!t) return null;
  const prev = await env.DB.prepare(`SELECT * FROM upstream_watch WHERE tool_id = ?`).bind(toolId).first<WatchRow>();
  const ref = parseRepoRef(t.upstream_url);
  const row: WatchRow = {
    tool_id: toolId, provider: ref?.provider ?? null, upstream_path: ref?.path ?? null, pin_kind: null, pinned: null, pin_package: null, pinned_version_id: t.latest_version_id,
    latest: prev?.latest ?? null, latest_at: prev?.latest_at ?? null, commits_behind: null, state: "unknown", upstream_license: prev?.upstream_license ?? null,
    releases_etag: prev?.releases_etag ?? null, override_json: prev?.override_json ?? null, error: null, checked_at: now, changed_at: prev?.changed_at ?? now,
  };
  try {
    if (!ref) throw new Error(`the homepage ${t.upstream_url} isn't a GitHub or GitLab repository`);
    const token = ref.provider === "github" ? await readToken(env) : "";
    const repo = await repoState(ref.provider, ref.path, token);
    row.upstream_license = repo.license ?? row.upstream_license;
    if (repo.state) {
      row.state = repo.state;
      row.error = repo.error ?? null;
    } else {
      const pin = await currentPin(t, prev, token);
      if (!pin) {
        row.pin_kind = "none";
        row.error = "no pinned upstream release found; set an override";
      } else {
        row.pin_kind = pin.kind;
        row.pinned = pin.ref;
        row.pin_package = pin.package ?? null;
        if (isCommitPin({ kind: pin.kind as Pin["kind"], ref: pin.ref, line: 0 })) {
          // A commit pin: how far upstream's default branch has moved on.
          const res = await deps.fetch(`https://api.github.com/repos/${ref.path}/compare/${pin.ref}...${repo.branch}`, { headers: ghHeaders(token) });
          if (!res.ok) throw new Error(`GitHub answered ${res.status} comparing ${pin.ref.slice(0, 7)}`);
          const cmp = (await res.json()) as { ahead_by: number; commits?: { commit: { committer?: { date?: string } } }[] };
          row.commits_behind = cmp.ahead_by;
          row.latest = cmp.ahead_by ? `${repo.branch} (${cmp.ahead_by} commits on)` : pin.ref;
          row.latest_at = Date.parse(cmp.commits?.at(-1)?.commit.committer?.date ?? "") || null;
          row.state = cmp.ahead_by > 0 ? "behind" : "current";
        } else {
          const rel = await latestRelease(ref.provider, ref.path, token, pin, prev?.releases_etag ?? null);
          if ("error" in rel && rel.error) throw new Error(rel.error);
          if (!("unchanged" in rel)) {
            row.latest = rel.latest ?? null;
            row.latest_at = rel.latest_at ?? null;
            if ("etag" in rel && rel.etag) row.releases_etag = rel.etag;
          }
          const cmp = row.latest ? compareVersions(pin.ref, row.latest) : 0;
          if (cmp === null) {
            row.state = "unknown";
            row.error = `can't compare the pinned ${pin.ref} with upstream's ${row.latest}`;
          } else row.state = cmp < 0 ? "behind" : "current";
        }
      }
    }
  } catch (e) {
    row.state = "error";
    row.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  if (!prev || prev.state !== row.state || prev.latest !== row.latest) row.changed_at = now;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO upstream_watch (tool_id, provider, upstream_path, pin_kind, pinned, pin_package, pinned_version_id, latest, latest_at,
       commits_behind, state, upstream_license, releases_etag, override_json, error, checked_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.tool_id, row.provider, row.upstream_path, row.pin_kind, row.pinned, row.pin_package, row.pinned_version_id, row.latest, row.latest_at, row.commits_behind, row.state,
    row.upstream_license, row.releases_etag, row.override_json, row.error, row.checked_at, row.changed_at).run();
  const mode = watchMode(env);
  const bump = mode === "prs" || mode === "auto" ? await maybeOpenBump(env, t, row, now).catch((e) => (console.error("the bump pull request failed", e), null)) : null;
  if (mode !== "report") await actOn(env, t, row, prev, now, bump, mode);
  if (mode === "auto" && opts.nightly) {
    await maybeAutoRelease(env, t, row, bump, now).catch((e) => console.error("releasing the bump on its own failed", e));
  }
  return row;
}

const STATE_TITLE: Partial<Record<WatchState, string>> = {
  archived: "The upstream repository was archived",
  gone: "The upstream repository is gone",
  renamed: "The upstream repository was renamed",
  license_changed: "The upstream project's license no longer allows redistribution",
};

/**
 * Issues mode: an outdated issue per upstream release (opened three days after it, closed when a published pin
 * catches up), and an issue when the upstream repository is archived, gone, renamed or relicensed. A license that no
 * longer allows redistribution also tells the admins, who decide; nothing is deprecated automatically.
 */
async function actOn(env: Env, t: Tool, row: WatchRow, prev: WatchRow | null, now: number, bump: BumpRow | null, mode: WatchMode) {
  const ref = `${t.ns}/${t.name}`;
  const openOutdated = (await env.DB.prepare(
    `SELECT dedupe_key FROM issues WHERE tool_id = ? AND dedupe_key LIKE 'outdated:%' AND status IN ('open', 'confirmed')`,
  ).bind(t.id).all<{ dedupe_key: string }>()).results.map((r) => r.dedupe_key);
  if (row.state === "behind" && row.latest && !row.commits_behind && (row.latest_at ?? 0) <= now - ISSUE_AFTER) {
    const key = `outdated:${row.latest}`;
    const issue = await fileSystemIssue(env, t.id, "outdated", {
      title: `Upstream released ${row.latest}`,
      markdown: `${row.upstream_path} released **${row.latest}**${row.latest_at ? ` on ${new Date(row.latest_at).toISOString().slice(0, 10)}` : ""}; ` +
        `the package pins ${row.pinned}. ${bump ? `[A pull request bumps the pin](${bump.url}); a maintainer merges and releases it from the package page.` : "A maintainer bumps the pin and releases a new version."} ` +
        (bump && mode === "auto" ? `It goes out automatically on ${new Date(autoReleaseAt(row, bump)).toISOString().slice(0, 10)} unless a maintainer turns that off on the package page. ` : "") +
        `This issue closes when a version pinning ${row.latest} is published.`,
    }, key, "upstream_watch");
    for (const k of openOutdated.filter((k) => k !== key)) await closeSystemIssue(env, t.id, k, "wont_fix", `Upstream has released a newer version since; see #${issue.number}.`);
  } else if (row.state === "current") {
    for (const k of openOutdated) await closeSystemIssue(env, t.id, k, "fixed", `The published package now pins ${row.pinned}, upstream's latest.`);
  }
  const title = STATE_TITLE[row.state];
  if (title && prev?.state !== row.state) {
    await fileSystemIssue(env, t.id, "outdated", {
      title,
      markdown: `${title.replace(/^The/, "the").replace(/^./, (c) => c.toUpperCase())}: ${t.upstream_url}. The package keeps working, but it won't get updates; ` +
        `a maintainer or staff may deprecate it in favour of another package.`,
    }, `upstream:${row.state}`, "upstream_watch");
    if (row.state === "license_changed") {
      const admins = (await env.DB.prepare(`SELECT id FROM users WHERE is_admin = 1 AND banned_at IS NULL`).all<{ id: string }>()).results.map((a) => a.id);
      await notify(env, admins, {
        kind: "status", scope: "account", path: `/${ref}`, tool_id: t.id,
        summary: `${ref}: upstream is now licensed ${row.upstream_license ?? "under terms"} the registry can't redistribute; decide whether to take it down`,
      });
    }
  }
}

/** For the public summary and the tool page: what the watcher last found. */
export const publicWatch = (w: WatchRow) => ({
  state: w.state, pinned: w.pinned, latest: w.latest, latest_at: w.latest_at, commits_behind: w.commits_behind, checked_at: w.checked_at,
});
