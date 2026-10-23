// Tool requests: anyone signed in asks for an open-source tool to be packaged, others add their vote, and triagers
// move each request from open to accepted, in progress, published or declined. A request is checked when it is made
// (the repository exists and is public, isn't in the registry or requested already, doesn't publish itself, has a
// license the registry may redistribute, isn't archived) and is linked to its package once one is published.
// Each request has a discussion thread, screened and moderated like issue comments, which its requester and the people
// who reply follow. Routes live in routes/requests.ts; the tables are in migrations 0018 and 0023; known-repos.ts is
// generated.
import { deps, requireSecret, type Env, type User } from "./env";
import { ulid } from "./lib/crypto";
import { apiError } from "./lib/errors";
import * as github from "./hosts/github";
import * as gitlab from "./hosts/gitlab";
import { githubUserToken, gitlabToken } from "./hosts/repo";
import { COMMUNITY_NAMESPACE, gitlabLicense, isRedistributable, licenseFromText, parseRepoRef } from "./imports";
import { audit } from "./routes/auth";
import {
  communityRoles, dailyLimit, holdReason, MAX_BODY, NEW_ACCOUNT, poster, REDACTED, refreshRequestReplies, renderPost, resolveFlags, screen,
} from "./community";
import { notify, requestSubscribers } from "./inbox";
import { DROPPED_REASONS, DROPPED_REPOS, OTLITE_REPOS } from "./known-repos";

export const REQUEST_STATUSES = ["open", "accepted", "in_progress", "published", "declined"] as const;
export const ACTIVE_STATUSES = ["open", "accepted", "in_progress"];
export const DECLINE_CODES = ["license", "archived", "not_osint", "not_cli", "needs_login", "acceptable_use", "unmaintained", "duplicate", "withdrawn", "other"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type DeclineCode = (typeof DECLINE_CODES)[number];

export const MAX_NOTE = 500;
/** How long each look at the upstream host may take. */
const UPSTREAM_TIMEOUT = 5000;

export type RequestRow = {
  id: string; number: number; provider: "github" | "gitlab"; repo_path: string; repo_key: string; project_id: string | null; url: string;
  description: string | null; license: string | null; upstream_stars: number | null; pushed_at: number | null; note: string | null;
  requested_by: string | null; status: RequestStatus; decline_code: DeclineCode | null; decision_note: string | null; decided_by: string | null;
  decided_at: number | null; tool_id: string | null; otlite_name: string | null; dropped_reason: string | null; vote_count: number;
  moderation: "visible" | "held" | "hidden"; hidden_reason: string | null; comment_count: number; locked_at: number | null; created_at: number; updated_at: number;
};

const keyOf = (provider: string, path: string) => `${provider}:${path.toLowerCase()}`;
const nameOf = (path: string) => path.split("/").pop()!;

/** What the registry already knows about a repository: an otlite tool, or why the seed survey left it out. */
export function knownRepo(provider: string, path: string): { otlite: string | null; dropped: string | null } {
  const key = keyOf(provider, path);
  const reason = DROPPED_REPOS[key];
  return { otlite: OTLITE_REPOS[key] ?? null, dropped: reason === undefined ? null : DROPPED_REASONS[reason] ?? null };
}

/** Request pages are left out of search engines until a triager has accepted the request. */
export const indexable = (r: Pick<RequestRow, "status" | "moderation">) => r.moderation === "visible" && ["accepted", "in_progress", "published"].includes(r.status);

// ---------- reading the upstream repository ----------

export interface Upstream {
  provider: "github" | "gitlab";
  path: string;
  projectId: string;
  url: string;
  description: string | null;
  license: string | null;
  archived: boolean;
  stars: number | null;
  pushedAt: number | null;
  hasManifest: boolean;
}

function within<T>(p: Promise<T>): Promise<T> {
  let timer: number | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), UPSTREAM_TIMEOUT);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer)).catch((e) => {
    if (e instanceof Error && e.message === "timeout") apiError(503, "upstream_unreachable", "the repository's host took too long to answer", "try again in a minute");
    throw e;
  });
}

/** A token to read public GitHub data with: the person's own, else the App's on the community organisation, else none. */
async function githubReadToken(env: Env, userId: string): Promise<string> {
  try {
    return await githubUserToken(env, userId);
  } catch {
    const inst = await env.DB.prepare(
      `SELECT i.github_installation_id FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE n.name = ? AND i.suspended_at IS NULL LIMIT 1`,
    ).bind(COMMUNITY_NAMESPACE).first<{ github_installation_id: number }>();
    if (!inst || !env.GITHUB_APP_PRIVATE_KEY) return "";
    return github.installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), inst.github_installation_id).catch(() => "");
  }
}

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

/** Reads what a request needs to know about a public repository, within a few seconds. */
export async function readUpstream(env: Env, userId: string, provider: "github" | "gitlab", path: string): Promise<Upstream> {
  if (provider === "github") {
    const token = await githubReadToken(env, userId);
    const r = await within(github.getRepo(deps.fetch, token, path));
    if (!r) apiError(404, "repo_not_found", `${path} does not exist on GitHub or is not public`);
    if (r.private) apiError(400, "repo_not_public", "only public repositories can be requested");
    const spdx = r.license?.spdx_id ?? null;
    const [manifest, ...texts] = await within(Promise.all([
      github.fileAt(deps.fetch, token, r.full_name, "otinstaller.yaml", r.default_branch),
      // GitHub couldn't name the license: read the file the way the import wizard does.
      ...(spdx === "NOASSERTION" ? LICENSE_FILES.map((f) => github.fileAt(deps.fetch, token, r.full_name, f, r.default_branch).catch(() => null)) : []),
    ]));
    const license = spdx && spdx !== "NOASSERTION" ? spdx : texts.map((t) => (t ? licenseFromText(t) : null)).find(Boolean) ?? null;
    return {
      provider, path: r.full_name, projectId: String(r.id), url: r.html_url, description: r.description, license, archived: r.archived,
      stars: r.stargazers_count ?? null, pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : null, hasManifest: manifest !== null,
    };
  }
  const token = await gitlabToken(env, userId).catch(() => "");
  const p = await within(gitlab.getProject(deps.fetch, token, path, true));
  if (!p || p.visibility !== "public") apiError(404, "project_not_found", `${path} does not exist on GitLab or is not public`);
  const manifest = await within(gitlab.rawFile(deps.fetch, token, String(p.id), "otinstaller.yaml", p.default_branch ?? "main"));
  return {
    provider, path: p.path_with_namespace, projectId: String(p.id), url: p.web_url, description: p.description ?? null, license: gitlabLicense(p.license?.key),
    archived: p.archived, stars: p.star_count ?? null, pushedAt: p.last_activity_at ? Date.parse(p.last_activity_at) : null, hasManifest: manifest !== null,
  };
}

// ---------- making a request ----------

export async function requestByNumber(env: Env, number: number): Promise<RequestRow | null> {
  return env.DB.prepare(`SELECT * FROM tool_requests WHERE number = ?`).bind(number).first<RequestRow>();
}

/** The published package that already comes from this repository (its own source, or a wrapper of it), if any. */
export async function packagedFrom(env: Env, provider: string, projectId: string, url: string): Promise<string | null> {
  const own = await env.DB.prepare(
    `SELECT n.name AS ns, t.name FROM sources s JOIN tools t ON t.id = s.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE s.provider = ? AND s.project_id = ? AND t.status != 'removed' AND t.latest_version_id IS NOT NULL`,
  ).bind(provider, projectId).first<{ ns: string; name: string }>();
  if (own) return `${own.ns}/${own.name}`;
  const wrapper = await env.DB.prepare(
    `SELECT n.name AS ns, t.name FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
     WHERE t.status != 'removed' AND lower(rtrim(json_extract(v.manifest_json, '$.homepage'), '/')) = lower(?) LIMIT 1`,
  ).bind(url.replace(/\/+$/, "")).first<{ ns: string; name: string }>();
  return wrapper ? `${wrapper.ns}/${wrapper.name}` : null;
}

const plain = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, MAX_NOTE);

/**
 * Makes a request after checking the repository. A license the registry can't redistribute, or an archived
 * repository, is recorded but declined at once, so the next person to ask sees why. Notes from new accounts, and
 * notes that look like personal data or secrets, wait for a moderator.
 */
export async function createRequest(env: Env, user: User, input: { repo?: unknown; note?: unknown }): Promise<{ row: RequestRow; notes: string[] }> {
  const ref = typeof input.repo === "string" ? parseRepoRef(input.repo) : null;
  if (!ref) apiError(400, "invalid_body", "send {repo} as a GitHub or GitLab repository URL", "for example https://github.com/owner/tool");
  const note = typeof input.note === "string" ? plain(input.note) : "";
  const p = await poster(env, user.id);
  // One request per repository. A withdrawn one is asked for again by reopening it.
  const existing = async (key: string, projectId?: string) => {
    const r = await env.DB.prepare(`SELECT * FROM tool_requests WHERE repo_key = ?${projectId ? " OR (provider = ? AND project_id = ?)" : ""} LIMIT 1`)
      .bind(key, ...(projectId ? [ref.provider, projectId] : [])).first<RequestRow>();
    if (r && !(r.status === "declined" && r.decline_code === "withdrawn")) {
      apiError(409, "request_exists", `${ref.path} was requested already, as #${r.number} (${r.status.replace("_", " ")})`, `vote for it: \`ot request ${ref.path} --vote\`, or on ${env.SITE_URL}/requests/${r.number}`, { number: r.number, status: r.status });
    }
    return r;
  };
  await existing(keyOf(ref.provider, ref.path));
  await dailyLimit(env, "request", user.id, 5);
  const up = await readUpstream(env, user.id, ref.provider, ref.path);
  const withdrawn = await existing(keyOf(up.provider, up.path), up.projectId);
  const packaged = await packagedFrom(env, up.provider, up.projectId, up.url);
  if (packaged) apiError(409, "already_in_registry", `${up.path} is in the registry already, as ${packaged}`, `run \`ot install ${packaged}\``, { ref: packaged });
  if (up.hasManifest) {
    apiError(409, "upstream_has_manifest", `${up.path} already has otinstaller.yaml, so its maintainer can publish it directly`, "ask them in their repository to push a release tag");
  }
  const known = knownRepo(up.provider, up.path);
  const declined: { reason: DeclineCode; note: string } | null = !isRedistributable(up.license)
    ? { reason: "license", note: up.license ? `Its license, ${up.license}, doesn't let the registry redistribute it.` : "It has no license the registry can identify, so it can't be redistributed." }
    : up.archived ? { reason: "archived", note: "The repository is archived, so nobody would keep a package of it current." } : null;
  const now = Date.now();
  const hits = note ? screen(note) : [];
  const held = now - p.created_at < NEW_ACCOUNT ? "new_account" : hits.length ? `screen:${hits.join(",")}` : null;
  const id = withdrawn?.id ?? ulid(now);
  const db = env.DB;
  const facts = [up.provider, up.path, keyOf(up.provider, up.path), up.projectId, up.url, up.description?.slice(0, 300) ?? null, up.license, up.stars, up.pushedAt,
    note || null, user.id, declined ? "declined" : "open", declined?.reason ?? null, declined?.note ?? null, declined ? now : null, known.otlite, known.dropped,
    held ? "held" : "visible", held];
  await db.batch([
    withdrawn
      ? db.prepare(
        `UPDATE tool_requests SET provider = ?, repo_path = ?, repo_key = ?, project_id = ?, url = ?, description = ?, license = ?, upstream_stars = ?, pushed_at = ?,
           note = ?, requested_by = ?, status = ?, decline_code = ?, decision_note = ?, decided_at = ?, decided_by = NULL, otlite_name = ?, dropped_reason = ?,
           moderation = ?, hidden_reason = ?, updated_at = ? WHERE id = ?`,
      ).bind(...facts, now, id)
      : db.prepare(
        `INSERT INTO tool_requests (id, number, provider, repo_path, repo_key, project_id, url, description, license, upstream_stars, pushed_at, note, requested_by,
           status, decline_code, decision_note, decided_at, otlite_name, dropped_reason, moderation, hidden_reason, vote_count, created_at, updated_at)
         SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? FROM tool_requests`,
      ).bind(id, ...facts, now, now),
    db.prepare(`INSERT OR IGNORE INTO request_votes (request_id, user_id, created_at) VALUES (?, ?, ?)`).bind(id, user.id, now),
    db.prepare(`UPDATE tool_requests SET vote_count = (SELECT COUNT(*) FROM request_votes WHERE request_id = ?1) WHERE id = ?1`).bind(id),
    db.prepare(`INSERT INTO request_subscriptions (request_id, user_id, reason, created_at) VALUES (?, ?, 'author', ?) ON CONFLICT DO UPDATE SET muted = 0`).bind(id, user.id, now),
    audit(db, user.id, "user", withdrawn ? "request.reopen" : "request.create", "request", id, { repo: `${up.provider}:${up.path}`, declined: declined?.reason ?? null, held: !!held }),
  ]);
  const row = (await db.prepare(`SELECT * FROM tool_requests WHERE id = ?`).bind(id).first<RequestRow>())!;
  const notes: string[] = [];
  if (declined) notes.push(`${declined.note} The request is recorded as declined so the next person to ask sees why.`);
  if (held) notes.push("A moderator looks at requests from new accounts, and notes that might hold personal data, before they show.");
  if (known.otlite) notes.push(`otlite, the no-Docker edition, installs it already: \`otlite install ${known.otlite}\`.`);
  if (known.dropped && !declined) notes.push(`When the registry was seeded in October 2026 it was left out because it is ${known.dropped}. A triager will look again.`);
  return { row, notes };
}

// ---------- votes ----------

/** Adds or removes the person's vote. Only open, accepted and in-progress requests take votes. */
export async function vote(env: Env, user: User, r: RequestRow, on: boolean): Promise<{ votes: number; voted: boolean }> {
  if (r.moderation !== "visible") apiError(404, "request_not_found", `there is no request #${r.number}`);
  if (!ACTIVE_STATUSES.includes(r.status)) apiError(409, "request_closed", `request #${r.number} is ${r.status.replace("_", " ")} and takes no more votes`);
  if (on) {
    await poster(env, user.id);
    await dailyLimit(env, "vote", user.id, 60);
  }
  const db = env.DB;
  await db.batch([
    on
      ? db.prepare(`INSERT OR IGNORE INTO request_votes (request_id, user_id, created_at) VALUES (?, ?, ?)`).bind(r.id, user.id, Date.now())
      : db.prepare(`DELETE FROM request_votes WHERE request_id = ? AND user_id = ?`).bind(r.id, user.id),
    db.prepare(`UPDATE tool_requests SET vote_count = (SELECT COUNT(*) FROM request_votes WHERE request_id = ?1) WHERE id = ?1`).bind(r.id),
  ]);
  const n = (await db.prepare(`SELECT vote_count FROM tool_requests WHERE id = ?`).bind(r.id).first<{ vote_count: number }>())!.vote_count;
  return { votes: n, voted: on };
}

// ---------- decisions ----------

const STATUS_WORDS: Record<RequestStatus, string> = { open: "reopened", accepted: "accepted", in_progress: "being packaged", published: "published", declined: "declined" };

/**
 * Moves a request on: triagers and staff accept, start, publish (naming the package), decline (with a reason) or
 * reopen it; the requester may withdraw their own. A null actor is the registry itself (a package was published).
 * The requester hears about every change, voters when it is published or declined.
 */
export async function setRequestStatus(
  env: Env, actor: User | null, r: RequestRow, status: RequestStatus, opts: { decline_code?: string; note?: string; tool?: string } = {},
): Promise<RequestRow> {
  const withdrawing = !!actor && actor.id === r.requested_by && status === "declined" && opts.decline_code === "withdrawn" && ACTIVE_STATUSES.includes(r.status);
  if (actor && !withdrawing && !(await communityRoles(env, actor)).has("triager")) {
    apiError(403, "not_triager", "only triagers and staff can decide requests", "the person who asked can withdraw it with decline_code withdrawn");
  }
  if (!(REQUEST_STATUSES as readonly string[]).includes(status)) apiError(400, "invalid_body", `status must be one of: ${REQUEST_STATUSES.join(", ")}`);
  if (status === r.status && status !== "published") apiError(409, "request_unchanged", `request #${r.number} is ${r.status.replace("_", " ")} already`);
  let code: DeclineCode | null = null;
  if (status === "declined") {
    if (!(DECLINE_CODES as readonly string[]).includes(String(opts.decline_code))) apiError(400, "invalid_body", `decline_code must be one of: ${DECLINE_CODES.join(", ")}`);
    code = opts.decline_code as DeclineCode;
    if (code === "withdrawn" && !withdrawing && actor) apiError(400, "invalid_body", "only the person who asked can withdraw a request");
  }
  let toolId: string | null = r.tool_id;
  if (status === "published") {
    const [ns, name] = String(opts.tool ?? "").split("/");
    const t = ns && name
      ? await env.DB.prepare(`SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ? AND t.latest_version_id IS NOT NULL AND t.status != 'removed'`)
        .bind(ns, name).first<{ id: string }>()
      : null;
    if (!t) apiError(400, "invalid_body", "send {tool: \"namespace/name\"} naming the published package that answers the request");
    toolId = t.id;
  }
  const note = typeof opts.note === "string" ? plain(opts.note) : "";
  const now = Date.now();
  const db = env.DB;
  await db.batch([
    db.prepare(
      `UPDATE tool_requests SET status = ?, decline_code = ?, decision_note = ?, decided_by = ?, decided_at = ?, tool_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, code, note || (status === "open" ? null : r.decision_note), actor?.id ?? null, now, toolId, now, r.id),
    audit(db, actor?.id ?? null, actor ? "user" : "system", `request.${status}`, "request", r.id, { decline_code: code, tool: opts.tool ?? null }),
  ]);
  const after = (await db.prepare(`SELECT * FROM tool_requests WHERE id = ?`).bind(r.id).first<RequestRow>())!;
  if (after.moderation === "visible") await announceDecision(env, actor, after);
  return after;
}

async function announceDecision(env: Env, actor: User | null, r: RequestRow) {
  const name = nameOf(r.repo_path);
  const item = { kind: "status" as const, scope: "community" as const, path: `/requests/${r.number}`, actor_id: actor?.id ?? null, tool_id: r.tool_id };
  const following = await requestSubscribers(env, r.id);
  const requester = r.requested_by && following.includes(r.requested_by) ? [r.requested_by] : [];
  await notify(env, requester, { ...item, summary: `Your request for ${name} (#${r.number}) was ${STATUS_WORDS[r.status]}` });
  await notify(env, following.filter((u) => u !== r.requested_by), { ...item, summary: `The request for ${name} (#${r.number}), which you follow, was ${STATUS_WORDS[r.status]}` });
  if (r.status === "published" || r.status === "declined") {
    const voters = (await env.DB.prepare(`SELECT user_id FROM request_votes WHERE request_id = ? AND user_id != COALESCE(?, '')`).bind(r.id, r.requested_by)
      .all<{ user_id: string }>()).results.map((v) => v.user_id).filter((u) => !following.includes(u));
    await notify(env, voters, { ...item, summary: `${name}, which you voted for (#${r.number}), was ${STATUS_WORDS[r.status]}` });
  }
}

/** Marks the requests a newly published package answers: those for its own repository or the upstream it wraps. */
export async function linkPublished(env: Env, toolId: string) {
  const t = await env.DB.prepare(
    `SELECT n.name AS ns, t.name, s.provider, s.project_id, json_extract(v.manifest_json, '$.homepage') AS homepage
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN sources s ON s.tool_id = t.id LEFT JOIN versions v ON v.id = t.latest_version_id WHERE t.id = ?`,
  ).bind(toolId).first<{ ns: string; name: string; provider: string | null; project_id: string | null; homepage: string | null }>();
  if (!t) return;
  const upstream = t.homepage ? parseRepoRef(t.homepage) : null;
  const rows = (await env.DB.prepare(
    `SELECT * FROM tool_requests WHERE status != 'published' AND ((provider = ? AND project_id = ?) OR repo_key = ?)`,
  ).bind(t.provider ?? "", t.project_id ?? "", upstream ? keyOf(upstream.provider, upstream.path) : "").all<RequestRow>()).results;
  for (const r of rows) await setRequestStatus(env, null, r, "published", { tool: `${t.ns}/${t.name}`, note: r.decision_note ?? "" });
}

// ---------- the discussion thread ----------

/** The badge a person's replies carry on requests: staff or triager; requests belong to no package. */
export async function requestBadge(env: Env, user: User): Promise<"staff" | "triager" | null> {
  if (user.is_admin || user.is_reviewer) return "staff";
  return (await communityRoles(env, user)).has("triager") ? "triager" : null;
}

/**
 * Adds a reply to a request's thread. Replies are screened like issue comments (new accounts, personal data, a first
 * post with links); triagers and staff are trusted. On a locked thread only they may reply.
 */
export async function addRequestComment(env: Env, r: RequestRow, user: User, body: string): Promise<{ id: string; moderation: string; body_html: string }> {
  const text = body.trim();
  if (text.length < 2) apiError(400, "invalid_body", "send {body}");
  if (text.length > MAX_BODY) apiError(400, "invalid_body", `a reply can be at most ${MAX_BODY} characters`);
  if (r.moderation !== "visible") apiError(409, "invalid_state", "this request is not open for replies");
  const badge = await requestBadge(env, user);
  if (r.locked_at && !badge) apiError(409, "request_locked", "replies to this request are closed", "if something has changed, say so on https://github.com/OTInstaller/feedback/issues");
  const p = await poster(env, user.id);
  await dailyLimit(env, "comment", user.id, 30);
  const now = Date.now();
  const held = badge ? null : holdReason(p, text, now);
  const id = ulid(now);
  const db = env.DB;
  await db.batch([
    db.prepare(`INSERT INTO request_comments (id, request_id, author_id, role_badge, body_md, moderation, hidden_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, r.id, user.id, badge, text, held ? "held" : "visible", held, now),
    refreshRequestReplies(db, r.id),
    db.prepare(`UPDATE tool_requests SET updated_at = ? WHERE id = ?`).bind(now, r.id),
    db.prepare(`INSERT INTO request_subscriptions (request_id, user_id, reason, created_at) VALUES (?, ?, 'commented', ?) ON CONFLICT DO NOTHING`).bind(r.id, user.id, now),
  ]);
  if (!held) {
    await notify(env, await requestSubscribers(env, r.id), {
      kind: "comment", scope: "community", summary: `${p.handle ?? user.login} replied on the request for ${nameOf(r.repo_path)} (#${r.number})`,
      path: `/requests/${r.number}`, actor_id: user.id,
    });
  }
  return { id, moderation: held ? "held" : "visible", body_html: renderPost(text, !badge) };
}

/** Closes or reopens a request's thread to replies (triagers and staff). */
export async function setRequestLocked(env: Env, r: RequestRow, actor: User, locked: boolean) {
  if (!(await requestBadge(env, actor))) apiError(403, "not_triager", "only triagers and staff can lock a request's thread");
  await env.DB.batch([
    env.DB.prepare(`UPDATE tool_requests SET locked_at = ? WHERE id = ?`).bind(locked ? Date.now() : null, r.id),
    audit(env.DB, actor.id, "user", locked ? "request.lock" : "request.unlock", "request", r.id),
  ]);
}

/** Follows or stops following a request's thread. */
export async function followRequest(env: Env, r: RequestRow, user: User, on: boolean) {
  await (on
    ? env.DB.prepare(`INSERT INTO request_subscriptions (request_id, user_id, reason, created_at) VALUES (?, ?, 'manual', ?) ON CONFLICT DO UPDATE SET muted = 0`).bind(r.id, user.id, Date.now())
    : env.DB.prepare(`UPDATE request_subscriptions SET muted = 1 WHERE request_id = ? AND user_id = ?`).bind(r.id, user.id)).run();
}

// ---------- moderation ----------

/** A moderator's decision on a request's note: hide or restore the request, approve a held one, or remove the note. */
export async function moderateRequest(env: Env, actor: User, id: string, action: "hide" | "restore" | "approve" | "redact", reason: string) {
  const r = await env.DB.prepare(`SELECT * FROM tool_requests WHERE id = ?`).bind(id).first<RequestRow>();
  if (!r) apiError(404, "request_not_found", "no such request");
  const db = env.DB;
  await db.batch([
    resolveFlags(db, actor, "request", id, action === "hide" || action === "redact"),
    action === "hide"
      ? db.prepare(`UPDATE tool_requests SET moderation = 'hidden', hidden_reason = ? WHERE id = ?`).bind(reason || "moderator", id)
      : action === "redact"
        ? db.prepare(`UPDATE tool_requests SET note = ?, moderation = 'visible', hidden_reason = NULL WHERE id = ?`).bind(REDACTED, id)
        : db.prepare(`UPDATE tool_requests SET moderation = 'visible', hidden_reason = NULL WHERE id = ?`).bind(id),
    audit(db, actor.id, "user", `request.${action}`, "request", id, reason ? { reason } : undefined),
  ]);
  if (r.requested_by) {
    const words = { hide: "hid", restore: "restored", approve: "approved", redact: "removed the note on" };
    await notify(env, [r.requested_by], { kind: "moderation", scope: "account", summary: `A moderator ${words[action]} your request for ${nameOf(r.repo_path)}`, path: `/requests/${r.number}`, actor_id: actor.id });
  }
}
