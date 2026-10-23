// Bump pull requests (UPSTREAM_WATCH=prs): when the watcher finds a community wrapper behind an upstream release for
// three days, the community bot opens otinstaller/bump-<release> in the wrapper repository, changing only the pin:
// the Dockerfile's pin line, or for wheels the manifest's version, package_version and wheel_sha256. The package's
// maintainers (its submitter and others staff add, the namespace's members) and reviewers then merge and release it:
// the bot merges the pull request and starts the release, the release workflow for builds or a tag for wheels. A pull
// request that changes anything besides the pin needs a reviewer. The table is in migration 0022.
import { deps, type Env, type User } from "./env";
import { apiError } from "./lib/errors";
import { semverParts } from "./lib/manifest";
import * as github from "./hosts/github";
import { HostError } from "./hosts/github";
import { pypiRelease } from "./hosts/artifacts";
import { audit } from "./routes/auth";
import { communityRoles, isMember } from "./community";
import { botConfigured, botToken } from "./submissions";
import { findPin, isCommitPin } from "./upstream-pin";
import { ISSUE_AFTER, type WatchRow } from "./upstream";

export type BumpRow = {
  tool_id: string; version: string; pr_number: number; url: string; branch: string; status: "open" | "merged" | "closed"; released_version: string | null;
  merged_by: string | null; created_at: number; updated_at: number;
};

type Tool = { id: string; name: string; ns: string; namespace_id: string; upstream_url: string; wrapper: string | null; manifest_json: string };

const WORKFLOW = "otinstaller-release.yml";
const plain = (v: string) => v.replace(/^v/, "");

/** The pinned reference written the way the old one was (with or without a leading v). */
const styled = (old: string, next: string) => (old.startsWith("v") ? `v${plain(next)}` : plain(next));

/** Pin kinds a bump can change: one line of a Dockerfile, or a wheel in the manifest. */
const BUMPABLE = new Set(["arg", "go", "pip", "pip_git", "git", "cargo", "cargo_git", "release_url", "raw_url", "pipx"]);

export async function openBumpFor(env: Env, toolId: string): Promise<BumpRow | null> {
  return env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`).bind(toolId).first<BumpRow>();
}

/**
 * Opens the bump pull request for what the watcher just found, once: only for a release (never commits), three days
 * after it came out, when the pin can be changed in one place, and when the community bot is set up.
 */
export async function maybeOpenBump(env: Env, t: Tool, w: WatchRow, now = Date.now()): Promise<BumpRow | null> {
  if (!botConfigured(env) || w.state !== "behind" || !w.latest || !w.pinned || !w.pin_kind || !t.wrapper) return null;
  if (!BUMPABLE.has(w.pin_kind) || w.commits_behind || isCommitPin({ kind: "git", ref: w.pinned, line: 0 }) || (w.latest_at ?? 0) > now - ISSUE_AFTER) return null;
  const existing = await env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, w.latest).first<BumpRow>();
  if (existing) return existing;
  const token = await botToken(env);
  const latest = w.latest;
  let file: github.FileChange;
  if (w.pin_kind === "pipx") {
    const m = JSON.parse(t.manifest_json) as { runtime?: { package?: string } };
    const wheel = m.runtime?.package ? await pypiRelease(deps.fetch, m.runtime.package, plain(latest)) : null;
    if (!wheel?.wheelSha256) return null;
    const yaml = await github.fileAt(deps.fetch, token, t.wrapper, "otinstaller.yaml", "main");
    if (!yaml) return null;
    const next = yaml
      .replace(/^version:\s*["']?[^\s"'#]+["']?/m, `version: ${plain(latest)}`)
      .replace(/^(\s+package_version:\s*)["']?[^\s"'#]+["']?/m, `$1"${plain(latest)}"`)
      .replace(/^(\s+wheel_sha256:\s*)["']?[0-9a-f]{64}["']?/m, `$1${wheel.wheelSha256}`);
    if (next === yaml) return null;
    file = { path: "otinstaller.yaml", content: next };
  } else {
    const dockerfile = await github.fileAt(deps.fetch, token, t.wrapper, "Dockerfile", "main");
    const pin = dockerfile ? findPin(dockerfile, t.upstream_url) : null;
    if (!dockerfile || !pin || pin.ref !== w.pinned) return null;
    const lines = dockerfile.split("\n");
    // The pin's instruction may continue over several lines; change the first one that names the pin.
    const i = lines.findIndex((l, n) => n >= pin.line - 1 && l.includes(pin.ref));
    if (i < 0) return null;
    lines[i] = lines[i]!.replace(pin.ref, styled(pin.ref, pin.kind === "pip" || pin.kind === "cargo" || pin.kind === "arg" ? plain(latest) : latest));
    file = { path: "Dockerfile", content: lines.join("\n") };
  }
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
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO bump_prs (tool_id, version, pr_number, url, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(t.id, latest, pr.number, pr.url, branch, now, now),
    // An older bump that never went in is superseded by this one.
    env.DB.prepare(`UPDATE bump_prs SET status = 'closed', updated_at = ? WHERE tool_id = ? AND status = 'open' AND version != ?`).bind(now, t.id, latest),
    audit(env.DB, null, "system", "bump.open", "tool", t.id, { version: latest, pr: pr.url }),
  ]);
  return env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(t.id, latest).first<BumpRow>();
}

/** Whether someone may merge and release a package's pin-only bumps: its maintainers, namespace members and reviewers. */
export async function canRelease(env: Env, user: User | null, t: Pick<Tool, "id" | "namespace_id">): Promise<{ maintainer: boolean; reviewer: boolean }> {
  if (!user) return { maintainer: false, reviewer: false };
  const reviewer = (await communityRoles(env, user)).has("reviewer");
  const listed = !!(await env.DB.prepare(`SELECT 1 FROM tool_maintainers WHERE tool_id = ? AND user_id = ?`).bind(t.id, user.id).first());
  return { maintainer: listed || (await isMember(env, t.namespace_id, user.id)), reviewer };
}

/** Whether a pull request's changes are the pin alone: one line of the Dockerfile, or the manifest's version fields. */
export function pinOnly(files: { filename: string; patch?: string }[]): boolean {
  if (files.length !== 1 || !files[0]!.patch) return false;
  const changed = files[0]!.patch.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
  if (files[0]!.filename === "Dockerfile") return changed.length === 2 && changed[0]!.startsWith("-") && changed[1]!.startsWith("+");
  if (files[0]!.filename === "otinstaller.yaml") return changed.length > 0 && changed.every((l) => /^[-+]\s*(version|package_version|wheel_sha256):/.test(l));
  return false;
}

/**
 * Merges a bump pull request and releases it: the release workflow builds upstream's release (the version is
 * upstream's), or a tag publishes the bumped manifest. A change beyond the pin needs a reviewer.
 */
export async function releaseBump(env: Env, actor: User, t: Tool, number: number): Promise<{ version: string; released: string }> {
  const who = await canRelease(env, actor, t);
  if (!who.maintainer && !who.reviewer) apiError(403, "not_package_maintainer", "only the package's maintainers and reviewers can merge and release a bump");
  const bump = await env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND pr_number = ? AND status = 'open'`).bind(t.id, number).first<BumpRow>();
  if (!bump || !t.wrapper) apiError(404, "bump_not_found", `${t.ns}/${t.name} has no open bump pull request #${number}`);
  const token = await botToken(env);
  if (!pinOnly(await github.pullFiles(deps.fetch, token, t.wrapper, number)) && !who.reviewer) {
    apiError(403, "not_pin_only", "the pull request changes more than the pin, so a reviewer merges it");
  }
  const sha = await github.mergePull(deps.fetch, token, t.wrapper, number, `Bump ${t.name} to ${bump.version}`).catch((e) => {
    if (e instanceof HostError) apiError(409, "bump_not_mergeable", `GitHub won't merge #${number}: ${e.message}`, "resolve it on GitHub, or ask a reviewer");
    throw e;
  });
  const m = JSON.parse(t.manifest_json) as { version: string; runtime?: { kind?: string } };
  let released: string;
  if (m.runtime?.kind === "pipx") {
    released = plain(bump.version);
    await github.createTag(deps.fetch, token, t.wrapper, `v${released}`, sha);
  } else {
    // The wrapper's version follows upstream's; a version that exists already gets a patch on top.
    const want = /^\d+\.\d+\.\d+$/.test(plain(bump.version)) ? plain(bump.version) : null;
    const taken = want ? await env.DB.prepare(`SELECT 1 FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, want).first() : true;
    const base = semverParts(want ?? m.version);
    released = taken ? `${base.major}.${base.minor}.${base.patch + 1}` : want!;
    await github.dispatchWorkflow(deps.fetch, token, t.wrapper, WORKFLOW, "main", { version: released });
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE bump_prs SET status = 'merged', released_version = ?, merged_by = ?, updated_at = ? WHERE tool_id = ? AND version = ?`)
      .bind(released, actor.id, now, t.id, bump.version),
    audit(env.DB, actor.id, "user", "bump.release", "tool", t.id, { pr: number, version: bump.version, released }),
  ]);
  return { version: bump.version, released };
}
