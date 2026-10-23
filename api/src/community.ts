// Community issues and discussion on packages: who may post and triage, how posts are screened, rendered and
// moderated, "works for me" confirmations, flags, and the system issues the registry files itself (the upstream
// watcher, many failed runs). Routes live in routes/community.ts; the tables are in migration 0016.
import type { Env, User } from "./env";
import { ulid } from "./lib/crypto";
import { apiError, rateLimited, windowRetry } from "./lib/errors";
import { findPersonalData, imagesToAlt, renderPage } from "./content";
import { audit } from "./routes/auth";
import { overLimit, type ToolRef } from "./trust";
import { maintainers, notify, requestSubscribers, subscribers } from "./inbox";

export const ISSUE_KINDS = ["broken", "outdated", "wrong_info", "feature", "question"] as const;
export const ISSUE_STATUSES = ["open", "confirmed", "fixed", "wont_fix", "duplicate"] as const;
export const OPEN_STATUSES = ["open", "confirmed"];
export const FLAG_REASONS = ["personal_data", "spam", "abuse", "off_topic", "other"] as const;
export const ENGINES = ["docker", "podman", "native"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type CommunityRole = "triager" | "reviewer";

export const MAX_TITLE = 140;
export const MAX_BODY = 8000;
/** How long authors can edit what they wrote. */
export const EDIT_WINDOW = 24 * 3600_000;
/** Accounts younger than this have their posts held for a moderator. */
export const NEW_ACCOUNT = 24 * 3600_000;
/** Closed threads lock after this long without activity. */
export const AUTO_LOCK = 30 * 86_400_000;
export const REDACTED = "[Removed by a moderator: this post contained personal data.]";

// ---------- who may do what ----------

/** The community roles a person holds; staff hold both. */
export async function communityRoles(env: Env, user: User | null): Promise<Set<CommunityRole>> {
  if (!user) return new Set();
  if (user.is_admin || user.is_reviewer) return new Set(["triager", "reviewer"]);
  const rows = (await env.DB.prepare(`SELECT role FROM community_roles WHERE user_id = ?`).bind(user.id).all<{ role: CommunityRole }>()).results;
  const roles = new Set(rows.map((r) => r.role));
  // A reviewer can always triage.
  if (roles.has("reviewer")) roles.add("triager");
  return roles;
}

/** Whether someone is a member of the package's namespace. */
export async function isMember(env: Env, namespaceId: string, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(namespaceId, userId).first());
}

/** The badge a person's comments carry on a package's thread, or null for everyone else. */
export async function roleBadge(env: Env, user: User, t: Pick<ToolRef, "namespace_id"> & { id?: string }): Promise<"maintainer" | "staff" | "triager" | null> {
  if (await isMember(env, t.namespace_id, user.id)) return "maintainer";
  // A community package's submitter and the others staff add maintain it too.
  if (t.id && (await env.DB.prepare(`SELECT 1 FROM tool_maintainers WHERE tool_id = ? AND user_id = ?`).bind(t.id, user.id).first())) return "maintainer";
  if (user.is_admin || user.is_reviewer) return "staff";
  return (await communityRoles(env, user)).has("triager") ? "triager" : null;
}

/** Package members, triagers and staff can triage a package's issues. */
export async function canTriage(env: Env, user: User | null, t: Pick<ToolRef, "namespace_id"> & { id?: string }): Promise<boolean> {
  if (!user) return false;
  return (await roleBadge(env, user, t)) !== null;
}

export async function requireTriage(env: Env, user: User | null, t: Pick<ToolRef, "namespace_id"> & { id?: string }): Promise<User> {
  if (!user) apiError(401, "unauthenticated", "sign in first", "run `ot login`, or sign in on otinstaller.com");
  if (!(await canTriage(env, user, t))) apiError(403, "not_triager", "only the package's maintainers, triagers and staff can do this");
  return user;
}

/** Moderators: triagers and staff, for queues across the registry. */
export async function requireModerator(env: Env, user: User | null): Promise<User> {
  if (!user) apiError(401, "unauthenticated", "sign in first", "run `ot login`, or sign in on otinstaller.com");
  if (!(await communityRoles(env, user)).has("triager")) apiError(403, "not_triager", "only triagers and staff can moderate");
  return user;
}

export type Poster = { created_at: number; posting_blocked_until: number | null; handle: string | null; visible_posts: number };

/** The poster's account age, timeout and how many of their posts are visible (first posts with links are held). */
export async function poster(env: Env, userId: string): Promise<Poster> {
  const p = await env.DB.prepare(
    `SELECT u.created_at, u.posting_blocked_until, u.handle,
       (SELECT COUNT(*) FROM issues WHERE author_id = u.id AND moderation = 'visible' AND deleted_at IS NULL)
       + (SELECT COUNT(*) FROM issue_comments WHERE author_id = u.id AND moderation = 'visible' AND deleted_at IS NULL)
       + (SELECT COUNT(*) FROM request_comments WHERE author_id = u.id AND moderation = 'visible' AND deleted_at IS NULL) AS visible_posts
     FROM users u WHERE u.id = ?`,
  ).bind(userId).first<Poster>();
  if (!p) apiError(401, "unauthenticated", "sign in first");
  if (p.posting_blocked_until && p.posting_blocked_until > Date.now()) {
    apiError(403, "posting_blocked", `you can't post until ${new Date(p.posting_blocked_until).toISOString().slice(0, 10)}`, "read the community guidelines at https://otinstaller.com/policy/community");
  }
  return p;
}

/** Applies a per-person daily limit for one kind of post. */
export async function dailyLimit(env: Env, scope: string, userId: string, limit: number) {
  if (await overLimit(env, scope, userId, limit, 86_400_000)) {
    rateLimited("too_many_posts", `at most ${limit} a day`, "try again tomorrow", windowRetry(86_400_000), limit, 86400);
  }
}

// ---------- screening and rendering ----------

const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Documentation, private and loopback ranges are fine to post.
const SAFE_IPV4 = /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|255\.)/;
const SECRETS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bot_[A-Za-z0-9_]{20,}/, /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** What in a post looks like someone's personal data or a secret. Hits hold the post for a moderator. */
export function screen(text: string): string[] {
  const reasons = new Set<string>();
  for (const hit of findPersonalData(text, "post", 5)) reasons.add(hit.kind === "name_address" ? "address" : hit.kind);
  for (const m of text.matchAll(IPV4)) if (!SAFE_IPV4.test(m[0])) reasons.add("ip_address");
  if (SECRETS.some((re) => re.test(text))) reasons.add("secret");
  return [...reasons];
}

const LINK = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/**
 * A post's Markdown as safe HTML: no raw HTML or images, external links marked nofollow and ugc. For people
 * without a visible post yet, links are shown as text so posting cannot buy links.
 */
export function renderPost(md: string, linksAsText = false): string {
  const r = renderPage(md.slice(0, MAX_BODY), { file: "post.md", root: "", pages: new Set(), pageUrl: () => "#", fileUrl: () => "#", strict: false, allowHtml: false });
  const html = imagesToAlt(r.html);
  return linksAsText
    ? html.replace(LINK, (_: string, href: string, text: string) => (href.startsWith("#") || text === href ? text : `${text} (${href})`))
    : html.replace(/<a href="(https?:[^"]*)"/g, '<a rel="nofollow ugc noopener" href="$1"');
}

/** Why a new post should wait for a moderator, or null to show it at once. */
export function holdReason(p: Poster, text: string, now = Date.now()): string | null {
  if (now - p.created_at < NEW_ACCOUNT) return "new_account";
  const hits = screen(text);
  if (hits.length) return `screen:${hits.join(",")}`;
  if (p.visible_posts === 0 && /https?:\/\//i.test(text)) return "first_post_with_links";
  return null;
}

// ---------- issues ----------

export interface IssueInput {
  kind: IssueKind;
  title: string;
  body: string;
  version?: string | null;
  platform?: string | null;
  engine?: string | null;
  exit_code?: number | null;
}

export type IssueRow = {
  id: string; tool_id: string; number: number; kind: IssueKind; status: IssueStatus; title: string; body_md: string;
  version: string | null; platform: string | null; engine: string | null; exit_code: number | null;
  author_id: string | null; author_kind: "user" | "system"; system_source: string | null; dedupe_key: string | null;
  duplicate_of: number | null; fixed_in: string | null; moderation: "visible" | "held" | "hidden"; hidden_reason: string | null;
  locked_at: number | null; deleted_at: number | null; edited_at: number | null; maintainer_replied_at: number | null;
  comment_count: number; me_too_count: number; created_at: number; last_activity_at: number; closed_at: number | null; closed_by: string | null;
};

/** Validates what a person sends for a new issue; throws invalid_body with what is wrong. */
export function issueInput(b: Record<string, unknown>): IssueInput {
  const kind = String(b.kind ?? "") as IssueKind;
  if (!ISSUE_KINDS.includes(kind)) apiError(400, "invalid_body", `kind must be one of: ${ISSUE_KINDS.join(", ")}`);
  const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
  if (title.length < 5) apiError(400, "invalid_body", "give a title of at least 5 characters");
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (body.length > MAX_BODY) apiError(400, "invalid_body", `the description can be at most ${MAX_BODY} characters`);
  if (kind !== "outdated" && body.length < 10) apiError(400, "invalid_body", "say what happened in at least 10 characters");
  const engine = b.engine == null || b.engine === "" ? null : String(b.engine);
  if (engine && !(ENGINES as readonly string[]).includes(engine)) apiError(400, "invalid_body", `engine must be one of: ${ENGINES.join(", ")}`);
  const exit = b.exit_code == null || b.exit_code === "" ? null : Number(b.exit_code);
  if (exit !== null && (!Number.isInteger(exit) || exit < 0 || exit > 255)) apiError(400, "invalid_body", "exit_code must be a number from 0 to 255");
  const short = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return { kind, title: title.slice(0, MAX_TITLE), body, version: short(b.version, 40), platform: short(b.platform, 40), engine, exit_code: exit };
}

/** Keeps a package's open broken and outdated counts in step with its visible issues. */
export function refreshCounts(db: D1Database, toolId: string): D1PreparedStatement {
  const count = (kind: string) =>
    `(SELECT COUNT(*) FROM issues WHERE tool_id = ?1 AND kind = '${kind}' AND status IN ('open', 'confirmed') AND moderation = 'visible' AND deleted_at IS NULL)`;
  return db.prepare(`UPDATE tools SET open_broken = ${count("broken")}, open_outdated = ${count("outdated")} WHERE id = ?1`).bind(toolId);
}

/** Opens an issue for a person. Held issues are kept from the public until a moderator approves them. */
export async function createIssue(env: Env, t: ToolRef, user: User, input: IssueInput): Promise<IssueRow> {
  const p = await poster(env, user.id);
  const young = Date.now() - p.created_at < 7 * 86_400_000;
  await dailyLimit(env, "issue", user.id, young ? 2 : 5);
  const now = Date.now();
  const id = ulid(now);
  const held = holdReason(p, `${input.title}\n${input.body}`, now);
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO issues (id, tool_id, number, kind, title, body_md, version, platform, engine, exit_code, author_id, moderation, hidden_reason, created_at, last_activity_at)
       SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM issues WHERE tool_id = ?`,
    ).bind(id, t.id, input.kind, input.title, input.body, input.version ?? null, input.platform ?? null, input.engine ?? null, input.exit_code ?? null,
      user.id, held ? "held" : "visible", held, now, now, t.id),
    db.prepare(`INSERT INTO issue_subscriptions (issue_id, user_id, reason, created_at) VALUES (?, ?, 'author', ?)`).bind(id, user.id, now),
    refreshCounts(db, t.id),
    audit(db, user.id, "user", "issue.create", "issue", id, { tool: t.id, kind: input.kind, held: !!held }),
  ]);
  const created = (await issueById(env, id))!;
  if (!held) await announceIssue(env, t, created, user.id);
  return created;
}

const refOf = (t: Pick<ToolRef, "namespace" | "name">) => `${t.namespace}/${t.name}`;
const KIND_WORDS: Record<IssueKind, string> = { broken: "broken", outdated: "outdated", wrong_info: "wrong-information", feature: "feature request", question: "question" };

/** Tells a package's maintainers about a new issue on it. */
async function announceIssue(env: Env, t: Pick<ToolRef, "namespace" | "name" | "namespace_id" | "id">, i: Pick<IssueRow, "id" | "number" | "kind" | "title">, actorId: string | null) {
  await notify(env, await maintainers(env, t.namespace_id, t.id), {
    kind: "issue_opened", scope: "owner_issues", summary: `New ${KIND_WORDS[i.kind]} issue on ${refOf(t)}: ${i.title}`,
    path: `/${refOf(t)}/issues/${i.number}`, tool_id: t.id, issue_id: i.id, actor_id: actorId,
  });
}

export async function issueById(env: Env, id: string): Promise<IssueRow | null> {
  return env.DB.prepare(`SELECT * FROM issues WHERE id = ?`).bind(id).first<IssueRow>();
}

export async function issueByNumber(env: Env, toolId: string, number: number): Promise<IssueRow | null> {
  return env.DB.prepare(`SELECT * FROM issues WHERE tool_id = ? AND number = ?`).bind(toolId, number).first<IssueRow>();
}

/** Whether search engines may index an issue's page: visible, and answered by a maintainer or settled. */
export const indexable = (i: Pick<IssueRow, "moderation" | "deleted_at" | "maintainer_replied_at" | "status">) =>
  i.moderation === "visible" && !i.deleted_at && (!!i.maintainer_replied_at || i.status === "confirmed" || i.status === "fixed");

/** Adds a comment. On a locked thread only people who can triage may comment. */
export async function addComment(env: Env, t: ToolRef, issue: IssueRow, user: User, body: string): Promise<{ id: string; moderation: string; body_html: string }> {
  const text = body.trim();
  if (text.length < 2) apiError(400, "invalid_body", "send {body}");
  if (text.length > MAX_BODY) apiError(400, "invalid_body", `a comment can be at most ${MAX_BODY} characters`);
  const badge = await roleBadge(env, user, t);
  if (issue.locked_at && !badge) apiError(409, "issue_locked", "this thread is locked");
  const p = await poster(env, user.id);
  await dailyLimit(env, "comment", user.id, 30);
  const now = Date.now();
  // People who can triage are trusted; everyone else is screened like a new issue.
  const held = badge ? null : holdReason(p, text, now);
  const id = ulid(now);
  const db = env.DB;
  await db.batch([
    db.prepare(`INSERT INTO issue_comments (id, issue_id, author_id, role_badge, body_md, moderation, hidden_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, issue.id, user.id, badge, text, held ? "held" : "visible", held, now),
    db.prepare(
      `UPDATE issues SET comment_count = (SELECT COUNT(*) FROM issue_comments WHERE issue_id = ?1 AND moderation = 'visible' AND deleted_at IS NULL),
         last_activity_at = ?2, maintainer_replied_at = COALESCE(maintainer_replied_at, ?3) WHERE id = ?1`,
    ).bind(issue.id, now, badge && !held ? now : null),
    db.prepare(`INSERT INTO issue_subscriptions (issue_id, user_id, reason, created_at) VALUES (?, ?, 'commented', ?) ON CONFLICT DO NOTHING`).bind(issue.id, user.id, now),
  ]);
  if (!held) {
    await notify(env, await subscribers(env, issue.id), {
      kind: "comment", scope: "community", summary: `${p.handle ?? user.login} replied on ${refOf(t)} #${issue.number}: ${issue.title}`,
      path: `/${refOf(t)}/issues/${issue.number}`, tool_id: t.id, issue_id: issue.id, actor_id: user.id,
    });
  }
  // The poster sees their reply at once; the public thread is cached for a minute.
  return { id, moderation: held ? "held" : "visible", body_html: renderPost(text, !badge) };
}

/** Changes an issue's status (triage). Closing a thread records who and when. */
export async function setStatus(env: Env, t: ToolRef, issue: IssueRow, actor: User, status: IssueStatus, opts: { duplicate_of?: number; fixed_in?: string } = {}) {
  if (status === "duplicate") {
    if (!opts.duplicate_of || opts.duplicate_of === issue.number || !(await issueByNumber(env, t.id, opts.duplicate_of))) {
      apiError(400, "invalid_body", "send {duplicate_of} with the number of another issue on this package");
    }
  }
  const now = Date.now();
  const closed = !OPEN_STATUSES.includes(status);
  const db = env.DB;
  await db.batch([
    db.prepare(
      `UPDATE issues SET status = ?, duplicate_of = ?, fixed_in = ?, closed_at = ?, closed_by = ?, last_activity_at = ? WHERE id = ?`,
    ).bind(status, status === "duplicate" ? opts.duplicate_of! : null, status === "fixed" ? opts.fixed_in?.slice(0, 40) ?? null : null,
      closed ? now : null, closed ? actor.id : null, now, issue.id),
    refreshCounts(db, t.id),
    audit(db, actor.id, "user", "issue.status", "issue", issue.id, { from: issue.status, to: status }),
  ]);
  await notify(env, await subscribers(env, issue.id), {
    kind: "status", scope: "community", summary: `${refOf(t)} #${issue.number} is now ${status.replace("_", " ")}: ${issue.title}`,
    path: `/${refOf(t)}/issues/${issue.number}`, tool_id: t.id, issue_id: issue.id, actor_id: actor.id,
  });
}

/** Locks or unlocks a thread. */
export async function setLocked(env: Env, issue: IssueRow, actor: User, locked: boolean) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE issues SET locked_at = ? WHERE id = ?`).bind(locked ? Date.now() : null, issue.id),
    audit(env.DB, actor.id, "user", locked ? "issue.lock" : "issue.unlock", "issue", issue.id),
  ]);
}

/** What people write: issues, replies on issues, and replies on tool requests. */
export type PostKind = "issue" | "comment" | "request_comment";
/** What can be flagged: any post, and a tool request (its note). */
export type FlagKind = PostKind | "request";
export const FLAG_KINDS: readonly FlagKind[] = ["issue", "comment", "request", "request_comment"];

const TABLE: Record<FlagKind, string> = { issue: "issues", comment: "issue_comments", request: "tool_requests", request_comment: "request_comments" };
const NOT_FOUND: Record<FlagKind, string> = { issue: "issue_not_found", comment: "comment_not_found", request: "request_not_found", request_comment: "comment_not_found" };
const WORD: Record<FlagKind, string> = { issue: "issue", comment: "comment", request: "request", request_comment: "reply" };

/** Updates a request's count of visible replies. */
export const refreshRequestReplies = (db: D1Database, requestId: string) =>
  db.prepare(`UPDATE tool_requests SET comment_count = (SELECT COUNT(*) FROM request_comments WHERE request_id = ?1 AND moderation = 'visible' AND deleted_at IS NULL) WHERE id = ?1`).bind(requestId);

const refreshIssueReplies = (db: D1Database, issueId: string) =>
  db.prepare(`UPDATE issues SET comment_count = (SELECT COUNT(*) FROM issue_comments WHERE issue_id = ?1 AND moderation = 'visible' AND deleted_at IS NULL) WHERE id = ?1`).bind(issueId);

/** The author edits their issue or comment within the edit window; edits are screened again. */
export async function editPost(env: Env, kind: PostKind, id: string, user: User, changes: { title?: string; body?: string }) {
  const table = TABLE[kind];
  const row = await env.DB.prepare(`SELECT author_id, created_at, moderation, deleted_at FROM ${table} WHERE id = ?`).bind(id)
    .first<{ author_id: string | null; created_at: number; moderation: string; deleted_at: number | null }>();
  if (!row || row.deleted_at) apiError(404, NOT_FOUND[kind], `no such ${WORD[kind]}`);
  if (row.author_id !== user.id) apiError(403, "forbidden", `only the author can edit this ${WORD[kind]}`);
  if (Date.now() - row.created_at > EDIT_WINDOW) apiError(409, "edit_window_closed", "posts can be edited for 24 hours", "add a comment instead");
  if (row.moderation === "hidden") apiError(409, "invalid_state", "a moderator hid this post");
  const p = await poster(env, user.id);
  const title = kind === "issue" ? changes.title?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : undefined;
  const body = changes.body?.trim();
  if (title === undefined && body === undefined) apiError(400, "invalid_body", kind === "issue" ? "send {title} or {body}" : "send {body}");
  if (body !== undefined && body.length > MAX_BODY) apiError(400, "invalid_body", `at most ${MAX_BODY} characters`);
  if (title !== undefined && title.length < 5) apiError(400, "invalid_body", "give a title of at least 5 characters");
  const held = holdReason(p, `${title ?? ""}\n${body ?? ""}`);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (title !== undefined) sets.push("title = ?"), values.push(title);
  if (body !== undefined) sets.push("body_md = ?"), values.push(body);
  sets.push("edited_at = ?");
  values.push(Date.now());
  if (held) sets.push("moderation = 'held'", "hidden_reason = ?"), values.push(held);
  await env.DB.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
  return { moderation: held ? "held" : row.moderation };
}

/** The author withdraws their issue or comment; the text is gone, the thread keeps its place. */
export async function deletePost(env: Env, kind: PostKind, id: string, user: User) {
  const parent = kind === "issue" ? "tool_id" : kind === "comment" ? "issue_id" : "request_id";
  const row = await env.DB.prepare(`SELECT author_id, deleted_at, ${parent} AS parent FROM ${TABLE[kind]} WHERE id = ?`).bind(id)
    .first<{ author_id: string | null; deleted_at: number | null; parent: string }>();
  if (!row || row.deleted_at) apiError(404, NOT_FOUND[kind], `no such ${WORD[kind]}`);
  if (row.author_id !== user.id) apiError(403, "forbidden", `only the author can delete this ${WORD[kind]}`);
  const db = env.DB;
  await db.batch([
    db.prepare(`UPDATE ${TABLE[kind]} SET deleted_at = ?, body_md = '' WHERE id = ?`).bind(Date.now(), id),
    kind === "issue" ? refreshCounts(db, row.parent) : kind === "comment" ? refreshIssueReplies(db, row.parent) : refreshRequestReplies(db, row.parent),
  ]);
}

// ---------- confirmations ----------

/**
 * Records that a version works, or is broken, for one person on one platform (replacing their earlier answer).
 * "broken" on an open broken issue counts as a "me too" on it.
 */
export async function confirm(env: Env, t: ToolRef, user: User, input: { result: "works" | "broken"; version?: string | null; platform?: string | null; engine?: string | null; ot_version?: string | null; issue?: IssueRow | null }) {
  await poster(env, user.id);
  await dailyLimit(env, "confirm", user.id, 60);
  const v = input.version
    ? await env.DB.prepare(`SELECT id, version FROM versions WHERE tool_id = ? AND version = ? AND status IN ('published', 'yanked')`).bind(t.id, input.version).first<{ id: string; version: string }>()
    : await env.DB.prepare(`SELECT id, version FROM versions WHERE id = ?`).bind(t.latest_version_id).first<{ id: string; version: string }>();
  if (!v) apiError(404, "version_not_found", `${t.namespace}/${t.name} has no version ${input.version ?? "published"}`);
  const platform = (input.platform ?? "").trim().slice(0, 40);
  const now = Date.now();
  const db = env.DB;
  const stmts = [
    db.prepare(
      `INSERT INTO confirmations (id, tool_id, version_id, user_id, result, platform, engine, ot_version, issue_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (version_id, user_id, platform) DO UPDATE SET result = excluded.result, engine = excluded.engine, ot_version = excluded.ot_version,
         issue_id = excluded.issue_id, created_at = excluded.created_at`,
    ).bind(ulid(now), t.id, v.id, user.id, input.result, platform, input.engine ?? null, input.ot_version?.slice(0, 20) ?? null, input.issue?.id ?? null, now),
  ];
  if (input.issue) {
    stmts.push(
      db.prepare(`UPDATE issues SET me_too_count = (SELECT COUNT(DISTINCT user_id) FROM confirmations WHERE issue_id = ?1 AND result = 'broken'), last_activity_at = ?2 WHERE id = ?1`)
        .bind(input.issue.id, now),
      db.prepare(`INSERT INTO issue_subscriptions (issue_id, user_id, reason, created_at) VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`).bind(input.issue.id, user.id, now),
    );
  }
  await db.batch(stmts);
  return { version: v.version, ...(await versionConfirmations(env, v.id)) };
}

/** Works and broken counts for a version in the last 30 days, by platform. */
export async function versionConfirmations(env: Env, versionId: string, now = Date.now()) {
  const rows = (await env.DB.prepare(
    `SELECT platform, result, COUNT(*) AS n FROM confirmations WHERE version_id = ? AND created_at > ? GROUP BY platform, result`,
  ).bind(versionId, now - 30 * 86_400_000).all<{ platform: string; result: "works" | "broken"; n: number }>()).results;
  const platforms: Record<string, { works: number; broken: number }> = {};
  let works = 0;
  let broken = 0;
  for (const r of rows) {
    const p = (platforms[r.platform || "unknown"] ??= { works: 0, broken: 0 });
    p[r.result] += r.n;
    if (r.result === "works") works += r.n;
    else broken += r.n;
  }
  return { works, broken, platforms };
}

// ---------- failed runs reported from ot ----------

export interface RunReport {
  version: string;
  exit_code: number | null;
  timed_out: boolean;
  os: string;
  arch: string;
  engine: string | null;
  ot_version: string | null;
}

/** How many failed-run reports from different addresses in a week open an "unconfirmed" issue. */
export const SIGNALS_FOR_ISSUE = 3;

/** Validates a report from ot's failure prompt: only these fields, never inputs or output. */
export function runReportInput(b: Record<string, unknown>): RunReport {
  const str = (v: unknown, max: number) => (typeof v === "string" && /^[A-Za-z0-9._\/+-]{1,40}$/.test(v) ? v.slice(0, max) : null);
  const version = str(b.version, 40);
  const os = str(b.os, 20);
  const arch = str(b.arch, 20);
  if (!version || !os || !arch) apiError(400, "invalid_body", "send {version, os, arch, exit_code | timed_out}");
  const exit = b.exit_code == null ? null : Number(b.exit_code);
  if (exit !== null && (!Number.isInteger(exit) || exit < 0 || exit > 255)) apiError(400, "invalid_body", "exit_code must be a number from 0 to 255");
  const timedOut = b.timed_out === true;
  if (exit === null && !timedOut) apiError(400, "invalid_body", "send exit_code, or timed_out: true");
  const engine = str(b.engine, 10);
  return { version, exit_code: exit, timed_out: timedOut, os, arch, engine: engine && (ENGINES as readonly string[]).includes(engine) ? engine : null, ot_version: str(b.ot_version, 20) };
}

/**
 * A failed run reported from ot. Signed in, it counts as "broken for me" on that version and platform and joins the
 * open broken issue for the version (or opens one, screened and limited like any issue). Anonymous, it only adds to a
 * daily count per version and platform, once per address a day; enough addresses in a week open an "unconfirmed" issue.
 */
export async function reportRun(env: Env, t: ToolRef, user: User | null, address: string, r: RunReport) {
  const v = await env.DB.prepare(`SELECT id, version FROM versions WHERE tool_id = ? AND version = ? AND status IN ('published', 'yanked')`).bind(t.id, r.version)
    .first<{ id: string; version: string }>();
  if (!v) apiError(404, "version_not_found", `${t.namespace}/${t.name} has no version ${r.version}`);
  const platform = `${r.os}/${r.arch}`;
  const what = r.timed_out ? "timed out" : `exited with ${r.exit_code}`;
  if (user) {
    await dailyLimit(env, "runreport", user.id, 20);
    const open = await env.DB.prepare(
      `SELECT * FROM issues WHERE tool_id = ? AND kind = 'broken' AND version = ? AND status IN ('open', 'confirmed') AND moderation = 'visible' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    ).bind(t.id, r.version).first<IssueRow>();
    if (open) {
      await confirm(env, t, user, { result: "broken", version: r.version, platform, engine: r.engine, ot_version: r.ot_version, issue: open });
      return { issue: open.number, created: false, moderation: "visible" };
    }
    const issue = await createIssue(env, t, user, {
      kind: "broken", title: `${r.version} ${what} on ${platform}`.slice(0, MAX_TITLE),
      body: `Reported from \`ot run\`: version ${r.version} ${what} on ${platform}${r.engine ? ` (${r.engine})` : ""}${r.ot_version ? `, ot ${r.ot_version}` : ""}. ot sends no inputs or output; add how to reproduce it with the tool's test input if you can.`,
      version: r.version, platform, engine: r.engine, exit_code: r.exit_code,
    });
    await confirm(env, t, user, { result: "broken", version: r.version, platform, engine: r.engine, ot_version: r.ot_version, issue });
    return { issue: issue.number, created: true, moderation: issue.moderation };
  }
  // Anonymous: one count per address, version and day, and a few reports a day per address.
  if (await overLimit(env, "runreport-ip", address, 10, 86_400_000)) {
    rateLimited("too_many_posts", "at most 10 reports a day from one address", "sign in with `ot login` to report more", windowRetry(86_400_000), 10, 86400);
  }
  const counted = !(await overLimit(env, "runsignal", `${address}|${v.id}`, 1, 86_400_000));
  if (counted) {
    await env.DB.prepare(
      `INSERT INTO run_signals (tool_id, version_id, day, platform, engine, exit_class, count) VALUES (?, ?, date('now'), ?, ?, ?, 1)
       ON CONFLICT (version_id, day, platform, engine, exit_class) DO UPDATE SET count = count + 1`,
    ).bind(t.id, v.id, platform, r.engine ?? "", r.timed_out ? "timeout" : "exit").run();
    const week = (await env.DB.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM run_signals WHERE version_id = ? AND day >= date('now', '-7 days')`).bind(v.id).first<{ n: number }>())!.n;
    if (week >= SIGNALS_FOR_ISSUE) {
      const rows = (await env.DB.prepare(`SELECT platform, SUM(count) AS n FROM run_signals WHERE version_id = ? AND day >= date('now', '-7 days') GROUP BY platform ORDER BY n DESC`).bind(v.id)
        .all<{ platform: string; n: number }>()).results;
      await fileSystemIssue(env, t.id, "broken", {
        title: `Several reports of ${r.version} failing (unconfirmed)`,
        markdown: `In the last 7 days, \`ot run\` sent ${week} reports, without a sign-in, that ${r.version} failed:\n\n${rows.map((x) => `- ${x.platform}: ${x.n}`).join("\n")}\n\nIf it fails for you too, say so here; if it works, say that instead.`,
        version: r.version,
      }, `run_signals:${r.version}`, "run_signals");
    }
  }
  return { counted };
}

// ---------- the status line ----------

export type StatusState = "working" | "mixed" | "failing" | "unknown";

const ago = (ms: number, now: number) => {
  const days = Math.floor((now - ms) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/**
 * How a package is doing, in one honest line: the registry's nightly health check first, then what signed-in people
 * said about the latest version in the last 30 days, then open broken issues. Facts with counts, never a score.
 */
export function statusLine(input: {
  health: string; checked_at: number | null; works: number; broken: number; platforms: string[]; open_broken: number; version: string;
}, now = Date.now()): { state: StatusState; text: string } {
  const parts: string[] = [];
  if (input.health === "healthy") parts.push(`Passed the registry's health check${input.checked_at ? ` ${ago(input.checked_at, now)}` : ""}`);
  else if (input.health === "broken") parts.push("Failing the registry's health check");
  else parts.push("Not health-checked yet");
  if (input.works || input.broken) {
    const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
    const said = [input.works ? `works for ${people(input.works)}` : null, input.broken ? `broken for ${people(input.broken)}` : null].filter(Boolean).join(", ");
    parts.push(`${input.version} ${said}${input.platforms.length ? ` (${input.platforms.slice(0, 3).join(", ")})` : ""} in the last 30 days`);
  }
  if (input.open_broken) parts.push(`${input.open_broken} open broken ${input.open_broken === 1 ? "issue" : "issues"}`);
  const state: StatusState =
    input.health === "broken" || (input.broken >= 2 && input.broken > input.works) ? "failing"
      : input.open_broken > 0 || input.broken > 0 ? "mixed"
        : input.health === "healthy" || input.works > 0 ? "working" : "unknown";
  return { state, text: `${parts.join("; ")}.` };
}

/** Everything the status line is made of, for GET /tools/:ns/:name/status. The error excerpts stay private. */
export async function communityStatus(env: Env, t: ToolRef, now = Date.now()) {
  const db = env.DB;
  const [tool, history, version] = await Promise.all([
    db.prepare(`SELECT health_status, health_checked_at, open_broken, open_outdated FROM tools WHERE id = ?`).bind(t.id)
      .first<{ health_status: string; health_checked_at: number | null; open_broken: number; open_outdated: number }>(),
    db.prepare(
      `SELECT h.ran_at, v.version, h.result, h.duration_ms, h.failure_class FROM health_checks h JOIN versions v ON v.id = h.version_id WHERE h.tool_id = ? ORDER BY h.ran_at DESC LIMIT 30`,
    ).bind(t.id).all<{ ran_at: number; version: string; result: string; duration_ms: number | null; failure_class: string | null }>(),
    db.prepare(`SELECT id, version FROM versions WHERE id = ?`).bind(t.latest_version_id).first<{ id: string; version: string }>(),
  ]);
  const counts = version ? await versionConfirmations(env, version.id, now) : { works: 0, broken: 0, platforms: {} };
  const platforms = Object.entries(counts.platforms).filter(([p, c]) => p !== "unknown" && c.works > 0).sort((a, b) => b[1].works - a[1].works).map(([p]) => p);
  const line = statusLine({
    health: tool?.health_status ?? "unknown", checked_at: tool?.health_checked_at ?? null, works: counts.works, broken: counts.broken, platforms,
    open_broken: tool?.open_broken ?? 0, version: version?.version ?? "",
  }, now);
  return {
    version: version?.version ?? null,
    line,
    health: {
      status: tool?.health_status ?? "unknown", checked_at: tool?.health_checked_at ?? null,
      history: history.results.map((h) => ({ at: h.ran_at, version: h.version, result: h.result, duration_ms: h.duration_ms, failure: h.failure_class })),
    },
    confirmations: { version: version?.version ?? null, ...counts },
    issues: { open_broken: tool?.open_broken ?? 0, open_outdated: tool?.open_outdated ?? 0 },
  };
}

// ---------- flags and moderation ----------

/**
 * Flags a post or a tool request. A personal-data flag from an established account hides it at once, pending a
 * moderator; three flags of any kind do the same.
 */
export async function flagPost(env: Env, user: User, kind: FlagKind, id: string, reason: (typeof FLAG_REASONS)[number], note: string) {
  const row = await env.DB.prepare(
    kind === "request"
      ? `SELECT moderation, requested_by AS author_id FROM tool_requests WHERE id = ?`
      : `SELECT moderation, author_id FROM ${TABLE[kind]} WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<{ moderation: string; author_id: string | null }>();
  if (!row) apiError(404, NOT_FOUND[kind], `no such ${WORD[kind]}`);
  await dailyLimit(env, "flag", user.id, 20);
  const p = await poster(env, user.id);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO content_flags (id, target_kind, target_id, flagger_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(ulid(now), kind, id, user.id, reason, note.slice(0, 500) || null, now).run();
  const open = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM content_flags WHERE target_kind = ? AND target_id = ? AND status = 'open'`).bind(kind, id).first<{ n: number }>())!.n;
  const trusted = now - p.created_at > 7 * 86_400_000;
  const hide = row.moderation === "visible" && ((reason === "personal_data" && trusted) || open >= 3);
  if (hide) await hidePost(env, null, kind, id, `flagged:${reason}`);
  return { hidden: hide || row.moderation !== "visible" };
}

/** Hides a post or request (from the public; its author and moderators still see it). */
async function hidePost(env: Env, actor: User | null, kind: FlagKind, id: string, reason: string) {
  const db = env.DB;
  const stmts = [db.prepare(`UPDATE ${TABLE[kind]} SET moderation = 'hidden', hidden_reason = ? WHERE id = ?`).bind(reason, id), audit(db, actor?.id ?? null, actor ? "user" : "system", `${kind}.hide`, kind, id, { reason })];
  stmts.push(...(await countsAfter(env, kind, id)));
  await db.batch(stmts);
}

/** The counter updates a change to a post's visibility needs. */
async function countsAfter(env: Env, kind: FlagKind, id: string): Promise<D1PreparedStatement[]> {
  const db = env.DB;
  if (kind === "request") return [];
  if (kind === "issue") {
    const i = await db.prepare(`SELECT tool_id FROM issues WHERE id = ?`).bind(id).first<{ tool_id: string }>();
    return i ? [refreshCounts(db, i.tool_id)] : [];
  }
  if (kind === "request_comment") {
    const c = await db.prepare(`SELECT request_id FROM request_comments WHERE id = ?`).bind(id).first<{ request_id: string }>();
    return c ? [refreshRequestReplies(db, c.request_id)] : [];
  }
  const c = await db.prepare(`SELECT issue_id FROM issue_comments WHERE id = ?`).bind(id).first<{ issue_id: string }>();
  return c ? [refreshIssueReplies(db, c.issue_id)] : [];
}

export type ModerationAction = "hide" | "restore" | "approve" | "redact";

/**
 * A moderator's decision on a post: hide it, restore or approve it, or redact it (the text is overwritten for good;
 * for personal data). Flags on the post are resolved with it. Requests themselves go through moderateRequest.
 */
export async function moderate(env: Env, actor: User, kind: PostKind, id: string, action: ModerationAction, reason: string) {
  const table = TABLE[kind];
  const row = await env.DB.prepare(`SELECT moderation FROM ${table} WHERE id = ?`).bind(id).first<{ moderation: string }>();
  if (!row) apiError(404, NOT_FOUND[kind], `no such ${WORD[kind]}`);
  const db = env.DB;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (action === "hide") stmts.push(db.prepare(`UPDATE ${table} SET moderation = 'hidden', hidden_reason = ? WHERE id = ?`).bind(reason || "moderator", id));
  else if (action === "restore" || action === "approve") stmts.push(db.prepare(`UPDATE ${table} SET moderation = 'visible', hidden_reason = NULL WHERE id = ?`).bind(id));
  else stmts.push(db.prepare(`UPDATE ${table} SET body_md = ?, moderation = 'hidden', hidden_reason = 'redacted'${kind === "issue" ? ", title = '[Removed]'" : ""} WHERE id = ?`).bind(REDACTED, id));
  stmts.push(resolveFlags(db, actor, kind, id, action === "hide" || action === "redact", now), audit(db, actor.id, "user", `${kind}.${action}`, kind, id, reason ? { reason } : undefined));
  await db.batch(stmts);
  await db.batch(await countsAfter(env, kind, id));
  await afterModeration(env, kind, id, action, row.moderation);
}

/** Settles the open flags on a post or request: upheld when a moderator hid or redacted it, else dismissed. */
export const resolveFlags = (db: D1Database, actor: User, kind: FlagKind, id: string, upheld: boolean, now = Date.now()) =>
  db.prepare(`UPDATE content_flags SET status = ?, resolved_by = ?, resolved_at = ? WHERE target_kind = ? AND target_id = ? AND status = 'open'`)
    .bind(upheld ? "upheld" : "dismissed", actor.id, now, kind, id);

const MODERATED: Record<ModerationAction, string> = { hide: "hid", redact: "removed", approve: "approved", restore: "restored" };

/** Tells the author what a moderator decided, and announces a held post once it is approved. */
async function afterModeration(env: Env, kind: PostKind, id: string, action: ModerationAction, before: string) {
  const db = env.DB;
  if (kind === "request_comment") {
    const r = await db.prepare(`SELECT c.author_id, r.id AS request_id, r.number, r.repo_path FROM request_comments c JOIN tool_requests r ON r.id = c.request_id WHERE c.id = ?`)
      .bind(id).first<{ author_id: string | null; request_id: string; number: number; repo_path: string }>();
    if (!r) return;
    const about = `the request for ${r.repo_path.split("/").pop()} (#${r.number})`;
    const path = `/requests/${r.number}`;
    if (r.author_id) await notify(env, [r.author_id], { kind: "moderation", scope: "account", summary: `A moderator ${MODERATED[action]} your reply on ${about}`, path });
    if (action === "approve" && before === "held") {
      await notify(env, await requestSubscribers(env, r.request_id), { kind: "comment", scope: "community", summary: `New reply on ${about}`, path, actor_id: r.author_id });
    }
    return;
  }
  const p = await db.prepare(
    kind === "issue"
      ? `SELECT i.author_id, i.id AS issue_id, i.number, i.kind, i.title, t.id AS tool_id, t.name, t.namespace_id, n.name AS namespace FROM issues i JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE i.id = ?`
      : `SELECT c.author_id, i.id AS issue_id, i.number, i.kind, i.title, t.id AS tool_id, t.name, t.namespace_id, n.name AS namespace FROM issue_comments c JOIN issues i ON i.id = c.issue_id JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE c.id = ?`,
  ).bind(id).first<{ author_id: string | null; issue_id: string; number: number; kind: IssueKind; title: string; tool_id: string; name: string; namespace_id: string; namespace: string }>();
  if (!p) return;
  const t = { id: p.tool_id, name: p.name, namespace: p.namespace, namespace_id: p.namespace_id };
  const path = `/${refOf(t)}/issues/${p.number}`;
  if (p.author_id) {
    await notify(env, [p.author_id], {
      kind: "moderation", scope: "account", summary: `A moderator ${MODERATED[action]} your ${kind} on ${refOf(t)} #${p.number}`, path,
      tool_id: t.id, issue_id: p.issue_id,
    });
  }
  // A post that waited for review reaches the people it would have reached when written.
  if (action === "approve" && before === "held") {
    if (kind === "issue") await announceIssue(env, t, { id: p.issue_id, number: p.number, kind: p.kind, title: p.title }, p.author_id);
    else {
      await notify(env, await subscribers(env, p.issue_id), {
        kind: "comment", scope: "community", summary: `New reply on ${refOf(t)} #${p.number}: ${p.title}`, path, tool_id: t.id, issue_id: p.issue_id, actor_id: p.author_id,
      });
    }
  }
}

/** Stops someone posting for up to 7 days. */
export async function timeout(env: Env, actor: User, handle: string, days: number, reason: string) {
  const u = await env.DB.prepare(`SELECT id FROM users WHERE handle = ?`).bind(handle).first<{ id: string }>();
  if (!u) apiError(404, "user_not_found", `nobody is called ${handle}`);
  const until = Date.now() + Math.min(Math.max(Math.round(days), 1), 7) * 86_400_000;
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET posting_blocked_until = ? WHERE id = ?`).bind(until, u.id),
    audit(env.DB, actor.id, "user", "user.timeout", "user", u.id, { until, reason }),
  ]);
  return until;
}

// ---------- system issues ----------

/**
 * Opens (or updates) an issue the registry files itself, such as "upstream released 2.1.0". The same dedupe key never
 * opens a second issue: an existing one is updated while open and left alone once closed.
 */
export async function fileSystemIssue(env: Env, toolId: string, kind: IssueKind, body: { title: string; markdown: string; version?: string }, dedupeKey: string, source: string): Promise<{ id: string; number: number; created: boolean }> {
  const db = env.DB;
  const existing = await db.prepare(`SELECT id, number, status FROM issues WHERE tool_id = ? AND dedupe_key = ?`).bind(toolId, dedupeKey).first<{ id: string; number: number; status: string }>();
  const now = Date.now();
  if (existing) {
    if (OPEN_STATUSES.includes(existing.status)) {
      await db.prepare(`UPDATE issues SET title = ?, body_md = ?, version = COALESCE(?, version) WHERE id = ?`).bind(body.title.slice(0, MAX_TITLE), body.markdown.slice(0, MAX_BODY), body.version ?? null, existing.id).run();
    }
    return { id: existing.id, number: existing.number, created: false };
  }
  const id = ulid(now);
  await db.batch([
    db.prepare(
      `INSERT INTO issues (id, tool_id, number, kind, title, body_md, version, author_kind, system_source, dedupe_key, created_at, last_activity_at)
       SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, 'system', ?, ?, ?, ? FROM issues WHERE tool_id = ?
       ON CONFLICT DO NOTHING`,
    ).bind(id, toolId, kind, body.title.slice(0, MAX_TITLE), body.markdown.slice(0, MAX_BODY), body.version ?? null, source, dedupeKey, now, now, toolId),
    refreshCounts(db, toolId),
    audit(db, null, "system", "issue.create", "issue", id, { tool: toolId, kind, source }),
  ]);
  const row = await db.prepare(`SELECT id, number FROM issues WHERE tool_id = ? AND dedupe_key = ?`).bind(toolId, dedupeKey).first<{ id: string; number: number }>();
  if (row!.id === id) {
    const t = await db.prepare(`SELECT t.id, t.name, t.namespace_id, n.name AS namespace FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE t.id = ?`).bind(toolId)
      .first<{ id: string; name: string; namespace_id: string; namespace: string }>();
    if (t) await announceIssue(env, t, { id, number: row!.number, kind, title: body.title }, null);
  }
  return { id: row!.id, number: row!.number, created: row!.id === id };
}

/** Closes an open system issue by its dedupe key, with a system comment saying why. False when none was open. */
export async function closeSystemIssue(env: Env, toolId: string, dedupeKey: string, status: "fixed" | "wont_fix", note?: string): Promise<boolean> {
  const db = env.DB;
  const issue = await db.prepare(`SELECT id FROM issues WHERE tool_id = ? AND dedupe_key = ? AND status IN ('open', 'confirmed')`).bind(toolId, dedupeKey).first<{ id: string }>();
  if (!issue) return false;
  const now = Date.now();
  const stmts = [db.prepare(`UPDATE issues SET status = ?, closed_at = ?, last_activity_at = ? WHERE id = ?`).bind(status, now, now, issue.id)];
  if (note) {
    stmts.push(
      db.prepare(`INSERT INTO issue_comments (id, issue_id, author_kind, body_md, created_at) VALUES (?, ?, 'system', ?, ?)`).bind(ulid(now), issue.id, note.slice(0, MAX_BODY), now),
      db.prepare(`UPDATE issues SET comment_count = comment_count + 1 WHERE id = ?`).bind(issue.id),
    );
  }
  stmts.push(refreshCounts(db, toolId), audit(db, null, "system", "issue.status", "issue", issue.id, { to: status }));
  await db.batch(stmts);
  return true;
}

/**
 * A new version is out: open broken and outdated issues get a system comment asking whether it fixes them, so the
 * people subscribed can check (called when a version is published).
 */
export async function announceVersion(env: Env, toolId: string, version: string) {
  const open = (await env.DB.prepare(
    `SELECT id FROM issues WHERE tool_id = ? AND kind IN ('broken', 'outdated') AND status IN ('open', 'confirmed') AND moderation = 'visible' AND deleted_at IS NULL AND author_kind = 'user'`,
  ).bind(toolId).all<{ id: string }>()).results;
  if (!open.length) return;
  const now = Date.now();
  const db = env.DB;
  await db.batch(open.flatMap((i) => [
    db.prepare(`INSERT INTO issue_comments (id, issue_id, author_kind, body_md, created_at) VALUES (?, ?, 'system', ?, ?)`)
      .bind(ulid(now), i.id, `Version ${version} is out. If it fixes this for you, say so here, or close the issue if you opened it.`, now),
    db.prepare(`UPDATE issues SET comment_count = comment_count + 1, last_activity_at = ? WHERE id = ?`).bind(now, i.id),
  ]));
}

/** Locks closed threads with no activity for AUTO_LOCK (nightly): issues, and requests published or declined. */
export async function lockStaleThreads(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE issues SET locked_at = ? WHERE locked_at IS NULL AND closed_at IS NOT NULL AND last_activity_at < ?`).bind(now, now - AUTO_LOCK),
    env.DB.prepare(`UPDATE tool_requests SET locked_at = ? WHERE locked_at IS NULL AND status IN ('published', 'declined') AND updated_at < ?`).bind(now, now - AUTO_LOCK),
  ]);
}
