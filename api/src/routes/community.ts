// Community routes: issues and comments on packages, confirmations, failed runs and problems reported without a
// sign-in, flags (on posts and tool requests), the registry-wide board, moderation queues and the roles admins grant.
// Rules and storage live in ../community.ts.
import type { Context } from "hono";
import type { App, AppEnv, User } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { audit, requireUser } from "./auth";
import { requireAdmin, requireReviewer } from "./review";
import { toolByRef, type ToolRef } from "../trust";
import { notify } from "../inbox";
import {
  addComment, canTriage, communityRoles, communityStatus, confirm, createIssue, deletePost, editPost, EDIT_WINDOW, fileSystemIssue, FLAG_KINDS, flagPost, FLAG_REASONS,
  indexable, ISSUE_KINDS, ISSUE_STATUSES, issueByNumber, issueInput, moderate, OPEN_STATUSES, problemReportInput, renderPost, reportProblem, reportRun, requireModerator,
  requireTriage, runReportInput, setLocked, setStatus, timeout, type FlagKind, type IssueRow, type IssueStatus, type ModerationAction,
} from "../community";
import { moderateRequest } from "../requests";

async function body<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({}) as Partial<T>);
}

/** The package an issue route is about; removed packages and namespaces that are not active have no issues. */
async function tool(c: Context<AppEnv>): Promise<ToolRef> {
  const { ns, name } = c.req.param() as { ns: string; name: string };
  const t = await toolByRef(c.env, ns, name);
  if (!t || t.namespace_status !== "active" || !t.latest_version_id) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  if (t.status === "removed") apiError(410, "tool_removed", `${ns}/${name} was removed from the registry`);
  return t;
}

/**
 * Reports that need no sign-in come from the registry's own pages or from programs such as ot, which send no Origin.
 * Another website can't have its visitors' browsers send them.
 */
function siteOrProgram(c: Context<AppEnv>) {
  const origin = c.req.header("origin");
  if (origin && origin !== c.env.SITE_URL) {
    apiError(403, "foreign_origin", "reports are taken only from the registry's website and from programs such as ot", `use Report a problem on the tool's page at ${c.env.SITE_URL}`);
  }
}

async function issue(c: Context<AppEnv>, t: ToolRef): Promise<IssueRow> {
  const n = Number(c.req.param("number"));
  const i = Number.isInteger(n) && n > 0 ? await issueByNumber(c.env, t.id, n) : null;
  if (!i) apiError(404, "issue_not_found", `${t.namespace}/${t.name} has no issue #${c.req.param("number")}`);
  return i;
}

const NEW_AUTHOR = 7 * 86_400_000;
type Author = { handle: string | null; login: string | null; avatar_url: string | null; profile_hidden: number | null; author_created: number | null };

/** How a post's author is shown: their handle and avatar, or the registry for system posts. */
function author(kind: string, a: Author) {
  if (kind === "system") return { system: true as const, handle: "otinstaller" };
  return { handle: a.handle ?? a.login?.toLowerCase() ?? "deleted", avatar_url: a.profile_hidden ? null : a.avatar_url, profile: !a.profile_hidden };
}

/** A post's HTML; links from people new to the community are shown as text. */
const html = (md: string, a: Author, badge: string | null, now = Date.now()) =>
  renderPost(md, !badge && (a.author_created ?? 0) > now - NEW_AUTHOR);

const USER_COLS = `u.handle, u.login, u.avatar_url, u.profile_hidden, u.created_at AS author_created`;

function summaryOf(i: IssueRow & Author) {
  return {
    number: i.number, kind: i.kind, status: i.status, title: i.title, author: author(i.author_kind, i), version: i.version, platform: i.platform,
    comments: i.comment_count, me_too: i.me_too_count, locked: !!i.locked_at, created_at: i.created_at, last_activity_at: i.last_activity_at,
    closed_at: i.closed_at, indexable: indexable(i),
  };
}

const PUBLIC = `i.moderation = 'visible' AND i.deleted_at IS NULL`;

export function communityRoutes(app: App) {
  // ---------- reading (public, cached) ----------

  app.get("/tools/:ns/:name/issues", async (c) => {
    const t = await tool(c);
    const status = c.req.query("status") ?? "open";
    if (!["open", "closed", "all"].includes(status)) apiError(400, "invalid_parameter", "status must be open, closed or all");
    const kind = c.req.query("kind");
    if (kind && !(ISSUE_KINDS as readonly string[]).includes(kind)) apiError(400, "invalid_parameter", `kind must be one of: ${ISSUE_KINDS.join(", ")}`);
    const before = Number(c.req.query("before") ?? 0) || null;
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
    const where = [`i.tool_id = ?`, PUBLIC, status === "open" ? `i.status IN (${open})` : status === "closed" ? `i.status NOT IN (${open})` : null,
      kind ? `i.kind = ?` : null, before ? `i.last_activity_at < ?` : null].filter(Boolean).join(" AND ");
    const binds = [t.id, ...(kind ? [kind] : []), ...(before ? [before] : [])];
    const [rows, counts] = await Promise.all([
      c.env.DB.prepare(`SELECT i.*, ${USER_COLS} FROM issues i LEFT JOIN users u ON u.id = i.author_id WHERE ${where} ORDER BY i.last_activity_at DESC LIMIT 31`)
        .bind(...binds).all<IssueRow & Author>(),
      c.env.DB.prepare(`SELECT SUM(i.status IN (${open})) AS open, SUM(i.status NOT IN (${open})) AS closed FROM issues i WHERE i.tool_id = ? AND ${PUBLIC}`)
        .bind(t.id).first<{ open: number | null; closed: number | null }>(),
    ]);
    const page = rows.results.slice(0, 30);
    cached(c, 60);
    return c.json({
      ref: `${t.namespace}/${t.name}`,
      counts: { open: counts?.open ?? 0, closed: counts?.closed ?? 0 },
      issues: page.map(summaryOf),
      next_before: rows.results.length > 30 ? page.at(-1)!.last_activity_at : null,
    });
  });

  app.get("/tools/:ns/:name/issues/:number", async (c) => {
    const t = await tool(c);
    const n = Number(c.req.param("number"));
    const i = Number.isInteger(n) && n > 0
      ? await c.env.DB.prepare(`SELECT i.*, ${USER_COLS} FROM issues i LEFT JOIN users u ON u.id = i.author_id WHERE i.tool_id = ? AND i.number = ? AND i.moderation = 'visible'`)
        .bind(t.id, n).first<IssueRow & Author>()
      : null;
    if (!i) apiError(404, "issue_not_found", `${t.namespace}/${t.name} has no issue #${c.req.param("number")}`);
    const comments = (await c.env.DB.prepare(
      `SELECT c.id, c.author_kind, c.role_badge, c.body_md, c.edited_at, c.created_at, ${USER_COLS} FROM issue_comments c LEFT JOIN users u ON u.id = c.author_id
       WHERE c.issue_id = ? AND c.moderation = 'visible' AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 500`,
    ).bind(i.id).all<{ id: string; author_kind: string; role_badge: string | null; body_md: string; edited_at: number | null; created_at: number } & Author>()).results;
    cached(c, 60);
    return c.json({
      ref: `${t.namespace}/${t.name}`,
      issue: {
        id: i.id, ...summaryOf(i), engine: i.engine, exit_code: i.exit_code, fixed_in: i.fixed_in, duplicate_of: i.duplicate_of, edited_at: i.edited_at,
        deleted: !!i.deleted_at, body_html: i.deleted_at ? "" : html(i.body_md, i, null),
      },
      comments: comments.map((cm) => ({
        id: cm.id, author: author(cm.author_kind, cm), role: cm.role_badge, created_at: cm.created_at, edited_at: cm.edited_at,
        body_html: cm.author_kind === "system" ? renderPost(cm.body_md) : html(cm.body_md, cm, cm.role_badge),
      })),
    });
  });

  // How a package is doing: the health check and its history, confirmations and open issues, in one line.
  app.get("/tools/:ns/:name/status", async (c) => {
    const t = await tool(c);
    const status = await communityStatus(c.env, t);
    cached(c, 300);
    return c.json({ ref: `${t.namespace}/${t.name}`, ...status });
  });

  // Open broken and outdated issues across the registry, for people who want to help.
  app.get("/issues", async (c) => {
    const kind = c.req.query("kind");
    if (kind && !(ISSUE_KINDS as readonly string[]).includes(kind)) apiError(400, "invalid_parameter", `kind must be one of: ${ISSUE_KINDS.join(", ")}`);
    const needs = c.req.query("needs");
    if (needs && needs !== "confirmation") apiError(400, "invalid_parameter", "needs must be confirmation");
    const before = Number(c.req.query("before") ?? 0) || null;
    const where = [PUBLIC, `t.status != 'removed' AND n.status = 'active' AND t.latest_version_id IS NOT NULL`,
      needs ? `i.kind = 'broken' AND i.status = 'open'` : `i.status IN ('open', 'confirmed')`,
      kind ? `i.kind = ?` : needs ? null : `i.kind IN ('broken', 'outdated', 'wrong_info')`, before ? `i.last_activity_at < ?` : null].filter(Boolean).join(" AND ");
    const rows = (await c.env.DB.prepare(
      `SELECT i.*, n.name AS ns, t.name AS tool, ${USER_COLS} FROM issues i JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id
       LEFT JOIN users u ON u.id = i.author_id WHERE ${where} ORDER BY i.last_activity_at DESC LIMIT 51`,
    ).bind(...(kind ? [kind] : []), ...(before ? [before] : [])).all<IssueRow & Author & { ns: string; tool: string }>()).results;
    const page = rows.slice(0, 50);
    cached(c, 120);
    return c.json({ issues: page.map((i) => ({ ref: `${i.ns}/${i.tool}`, ...summaryOf(i) })), next_before: rows.length > 50 ? page.at(-1)!.last_activity_at : null });
  });

  // What the signed-in person may do on a thread, and their own posts still waiting for a moderator.
  app.get("/tools/:ns/:name/issues/:number/viewer", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const i = await issue(c, t);
    const [sub, held, mine] = await Promise.all([
      c.env.DB.prepare(`SELECT muted FROM issue_subscriptions WHERE issue_id = ? AND user_id = ?`).bind(i.id, u.id).first<{ muted: number }>(),
      c.env.DB.prepare(`SELECT id, body_md, created_at FROM issue_comments WHERE issue_id = ? AND author_id = ? AND moderation = 'held' AND deleted_at IS NULL ORDER BY created_at`)
        .bind(i.id, u.id).all<{ id: string; body_md: string; created_at: number }>(),
      c.env.DB.prepare(`SELECT id, created_at FROM issue_comments WHERE issue_id = ? AND author_id = ? AND moderation = 'visible' AND deleted_at IS NULL`).bind(i.id, u.id)
        .all<{ id: string; created_at: number }>(),
    ]);
    c.header("Cache-Control", "private, no-store");
    const now = Date.now();
    return c.json({
      can_triage: await canTriage(c.env, u, t),
      is_author: i.author_id === u.id,
      can_edit_issue: i.author_id === u.id && now - i.created_at < EDIT_WINDOW,
      editable_comments: mine.results.filter((m) => now - m.created_at < EDIT_WINDOW).map((m) => m.id),
      subscribed: !!sub && !sub.muted,
      held_comments: held.results.map((h) => ({ id: h.id, created_at: h.created_at, body_html: renderPost(h.body_md, true) })),
    });
  });

  // ---------- posting (signed in, scope feedback) ----------

  app.post("/tools/:ns/:name/issues", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const created = await createIssue(c.env, t, u, issueInput(await body<Record<string, unknown>>(c)));
    c.header("Cache-Control", "private, no-store");
    return c.json({
      ref: `${t.namespace}/${t.name}`, number: created.number, moderation: created.moderation,
      note: created.moderation === "held" ? "Thanks. A moderator checks new accounts' first posts and anything that looks like personal data before it is shown." : undefined,
    }, 201);
  });

  app.post("/tools/:ns/:name/issues/:number/comments", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const i = await issue(c, t);
    if (i.deleted_at || i.moderation !== "visible") apiError(409, "invalid_state", "this issue is not open for comments");
    const b = await body<{ body: string }>(c);
    const r = await addComment(c.env, t, i, u, typeof b.body === "string" ? b.body : "");
    c.header("Cache-Control", "private, no-store");
    return c.json(r, 201);
  });

  app.patch("/tools/:ns/:name/issues/:number", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const i = await issue(c, t);
    const b = await body<{ title: string; body: string }>(c);
    return c.json(await editPost(c.env, "issue", i.id, u, { title: typeof b.title === "string" ? b.title : undefined, body: typeof b.body === "string" ? b.body : undefined }));
  });

  app.delete("/tools/:ns/:name/issues/:number", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const i = await issue(c, t);
    await deletePost(c.env, "issue", i.id, u);
    return c.json({ deleted: true });
  });

  app.patch("/comments/:id", async (c) => {
    const u = requireUser(c);
    const b = await body<{ body: string }>(c);
    return c.json(await editPost(c.env, "comment", c.req.param("id"), u, { body: typeof b.body === "string" ? b.body : undefined }));
  });

  app.delete("/comments/:id", async (c) => {
    const u = requireUser(c);
    await deletePost(c.env, "comment", c.req.param("id"), u);
    return c.json({ deleted: true });
  });

  // A failed run from ot's prompt: tool, version, exit code, OS and ot version only. A token is optional.
  app.post("/tools/:ns/:name/run-reports", async (c) => {
    siteOrProgram(c);
    const t = await tool(c);
    const r = runReportInput(await body<Record<string, unknown>>(c));
    c.header("Cache-Control", "private, no-store");
    return c.json(await reportRun(c.env, t, c.get("user"), c.req.header("cf-connecting-ip") ?? "unknown", r), 201);
  });

  // "Broken" or "outdated" from a tool page's Report a problem, without a sign-in: counted, never who sent it.
  app.post("/tools/:ns/:name/problem-reports", async (c) => {
    siteOrProgram(c);
    const t = await tool(c);
    const r = problemReportInput(await body<Record<string, unknown>>(c));
    c.header("Cache-Control", "private, no-store");
    return c.json(await reportProblem(c.env, t, c.req.header("cf-connecting-ip") ?? "unknown", r), 201);
  });

  // "Works for me" or "broken for me" on a version; with {issue} a "broken" counts as a "me too" on that issue.
  app.put("/tools/:ns/:name/confirmations", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const b = await body<{ result: string; version: string; platform: string; engine: string; ot_version: string; issue: number }>(c);
    if (b.result !== "works" && b.result !== "broken") apiError(400, "invalid_body", "send {result: 'works' | 'broken', version?, platform?}");
    const i = b.issue ? await issueByNumber(c.env, t.id, Number(b.issue)) : null;
    if (b.issue && !i) apiError(404, "issue_not_found", `${t.namespace}/${t.name} has no issue #${b.issue}`);
    c.header("Cache-Control", "private, no-store");
    return c.json(await confirm(c.env, t, u, {
      result: b.result, version: typeof b.version === "string" ? b.version : null, platform: typeof b.platform === "string" ? b.platform : null,
      engine: typeof b.engine === "string" ? b.engine : null, ot_version: typeof b.ot_version === "string" ? b.ot_version : null, issue: i,
    }));
  });

  for (const method of ["put", "delete"] as const) {
    app[method]("/tools/:ns/:name/issues/:number/subscription", async (c) => {
      const u = requireUser(c);
      const t = await tool(c);
      const i = await issue(c, t);
      if (method === "put") {
        await c.env.DB.prepare(`INSERT INTO issue_subscriptions (issue_id, user_id, reason, created_at) VALUES (?, ?, 'manual', ?) ON CONFLICT DO UPDATE SET muted = 0`)
          .bind(i.id, u.id, Date.now()).run();
      } else {
        await c.env.DB.prepare(`UPDATE issue_subscriptions SET muted = 1 WHERE issue_id = ? AND user_id = ?`).bind(i.id, u.id).run();
      }
      return c.json({ subscribed: method === "put" });
    });
  }

  // ---------- following a package's releases ----------

  // Whether the signed-in person follows the package's releases.
  app.get("/tools/:ns/:name/follow", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const f = await c.env.DB.prepare(`SELECT created_at FROM package_follows WHERE tool_id = ? AND user_id = ?`).bind(t.id, u.id).first<{ created_at: number }>();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: !!f, followed_at: f?.created_at ?? null });
  });

  // Follow: an inbox item (and an email, per the "releases" preference) for each new version that becomes the latest.
  app.put("/tools/:ns/:name/follow", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    await c.env.DB.prepare(`INSERT INTO package_follows (tool_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).bind(t.id, u.id, Date.now()).run();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: true });
  });

  // Unfollow works for any package someone follows, even one removed since.
  app.delete("/tools/:ns/:name/follow", async (c) => {
    const u = requireUser(c);
    const { ns, name } = c.req.param() as { ns: string; name: string };
    const t = await toolByRef(c.env, ns, name);
    if (!t) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
    await c.env.DB.prepare(`DELETE FROM package_follows WHERE tool_id = ? AND user_id = ?`).bind(t.id, u.id).run();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: false });
  });

  app.post("/flags", async (c) => {
    const u = requireUser(c);
    const b = await body<{ target_kind: string; target_id: string; reason: string; note: string }>(c);
    if (!FLAG_KINDS.includes(b.target_kind as FlagKind)) apiError(400, "invalid_body", `target_kind must be one of: ${FLAG_KINDS.join(", ")}`);
    if (!(FLAG_REASONS as readonly string[]).includes(String(b.reason))) apiError(400, "invalid_body", `reason must be one of: ${FLAG_REASONS.join(", ")}`);
    if (typeof b.target_id !== "string" || !b.target_id) apiError(400, "invalid_body", "send {target_id}");
    const r = await flagPost(c.env, u, b.target_kind as FlagKind, b.target_id, b.reason as (typeof FLAG_REASONS)[number], typeof b.note === "string" ? b.note : "");
    return c.json({ ...r, note: "Thanks. A moderator will look at it." }, 201);
  });

  // ---------- triage (maintainers, triagers, staff; the author may close their own issue as fixed) ----------

  app.post("/tools/:ns/:name/issues/:number/status", async (c) => {
    const u = requireUser(c);
    const t = await tool(c);
    const i = await issue(c, t);
    const b = await body<{ status: string; duplicate_of: number; fixed_in: string }>(c);
    const status = String(b.status) as IssueStatus;
    if (!(ISSUE_STATUSES as readonly string[]).includes(status)) apiError(400, "invalid_body", `status must be one of: ${ISSUE_STATUSES.join(", ")}`);
    const authorClosing = i.author_id === u.id && (status === "fixed" || (status === "open" && i.status === "fixed" && i.closed_by === u.id));
    if (!authorClosing) await requireTriage(c.env, u, t);
    await setStatus(c.env, t, i, u, status, { duplicate_of: b.duplicate_of ? Number(b.duplicate_of) : undefined, fixed_in: typeof b.fixed_in === "string" ? b.fixed_in : undefined });
    return c.json({ number: i.number, status });
  });

  app.post("/tools/:ns/:name/issues/:number/lock", async (c) => {
    const t = await tool(c);
    const u = await requireTriage(c.env, c.get("user"), t);
    const i = await issue(c, t);
    const b = await body<{ locked: boolean }>(c);
    await setLocked(c.env, i, u, b.locked !== false);
    return c.json({ number: i.number, locked: b.locked !== false });
  });

  // ---------- moderation (triagers and staff; a package's maintainers for comments on its issues) ----------

  app.post("/moderation/:kind/:id", async (c) => {
    const u = requireUser(c);
    const kind = c.req.param("kind") as FlagKind;
    if (!FLAG_KINDS.includes(kind)) apiError(404, "not_found", "no such route");
    const id = c.req.param("id");
    const b = await body<{ action: string; reason: string }>(c);
    const action = String(b.action) as ModerationAction;
    if (!["hide", "restore", "approve", "redact"].includes(action)) apiError(400, "invalid_body", "action must be hide, restore, approve or redact");
    const roles = await communityRoles(c.env, u);
    const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : "";
    if (kind === "request" || kind === "request_comment") {
      // Requests belong to no package, so only triagers and staff moderate them and their replies. A request's note is
      // the only thing in it people write; redacting removes the note for good.
      if (!roles.has("triager")) apiError(403, "not_triager", "only triagers and staff can do this");
      if (action === "redact" && !u.is_admin && !u.is_reviewer) apiError(403, "forbidden", "only staff can redact posts");
      if (kind === "request") await moderateRequest(c.env, u, id, action, reason);
      else await moderate(c.env, u, kind, id, action, reason);
      return c.json({ kind, id, action });
    }
    if (!roles.has("triager")) {
      // Maintainers may hide comments on their own package's issues, but not issues or redactions.
      const owner = kind === "comment" && action === "hide"
        ? await c.env.DB.prepare(`SELECT t.namespace_id FROM issue_comments cm JOIN issues i ON i.id = cm.issue_id JOIN tools t ON t.id = i.tool_id WHERE cm.id = ?`).bind(id).first<{ namespace_id: string }>()
        : null;
      if (!owner || !(await canTriage(c.env, u, owner))) apiError(403, "not_triager", "only triagers and staff can do this");
    }
    if (action === "redact" && !u.is_admin && !u.is_reviewer) apiError(403, "forbidden", "only staff can redact posts");
    await moderate(c.env, u, kind, id, action, reason);
    return c.json({ kind, id, action });
  });

  app.get("/moderation/queue", async (c) => {
    await requireModerator(c.env, c.get("user"));
    const view = c.req.query("view") ?? "held";
    if (!["held", "flags"].includes(view)) apiError(400, "invalid_parameter", "view must be held or flags");
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    c.header("Cache-Control", "private, no-store");
    if (view === "held") {
      const rows = (await c.env.DB.prepare(
        `SELECT 'issue' AS kind, i.id AS id, i.title AS title, i.body_md AS body_md, i.hidden_reason AS hidden_reason, i.created_at AS created_at,
           n.name AS ns, t.name AS tool, i.number AS number, u.handle AS handle
           FROM issues i JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN users u ON u.id = i.author_id
           WHERE i.moderation != 'visible' AND i.deleted_at IS NULL AND i.created_at < ?1
         UNION ALL
         SELECT 'comment', cm.id, NULL, cm.body_md, cm.hidden_reason, cm.created_at, n.name, t.name, i.number, u.handle
           FROM issue_comments cm JOIN issues i ON i.id = cm.issue_id JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id
           LEFT JOIN users u ON u.id = cm.author_id WHERE cm.moderation != 'visible' AND cm.deleted_at IS NULL AND cm.created_at < ?1
         UNION ALL
         SELECT 'request', r.id, r.repo_path, COALESCE(r.note, ''), r.hidden_reason, r.created_at, NULL, NULL, r.number, u.handle
           FROM tool_requests r LEFT JOIN users u ON u.id = r.requested_by WHERE r.moderation != 'visible' AND r.created_at < ?1
         UNION ALL
         SELECT 'request_comment', rc.id, r.repo_path, rc.body_md, rc.hidden_reason, rc.created_at, NULL, NULL, r.number, u.handle
           FROM request_comments rc JOIN tool_requests r ON r.id = rc.request_id LEFT JOIN users u ON u.id = rc.author_id
           WHERE rc.moderation != 'visible' AND rc.deleted_at IS NULL AND rc.created_at < ?1
         ORDER BY created_at DESC LIMIT 100`,
      ).bind(before).all<{ kind: string; id: string; title: string | null; body_md: string; hidden_reason: string | null; created_at: number; ns: string | null; tool: string | null; number: number; handle: string | null }>()).results;
      return c.json({
        items: rows.map((r) => ({ ...r, ref: r.ns ? `${r.ns}/${r.tool}` : null, body_html: renderPost(r.body_md, true) })),
        next_before: rows.length === 100 ? rows.at(-1)!.created_at : null,
      });
    }
    // Each flag with where its target is on the site and what it says, so a moderator can judge it from the queue.
    const flags = (await c.env.DB.prepare(
      `SELECT f.id, f.target_kind, f.target_id, f.reason, f.note, f.created_at, u.handle AS flagger,
         COALESCE(i.title || char(10) || i.body_md, ic.body_md, r.note, rc.body_md, '') AS text,
         COALESCE(i.moderation, ic.moderation, r.moderation, rc.moderation) AS moderation,
         CASE f.target_kind
           WHEN 'issue' THEN '/' || n1.name || '/' || t1.name || '/issues/' || i.number
           WHEN 'comment' THEN '/' || n2.name || '/' || t2.name || '/issues/' || ii.number || '#c-' || ic.id
           WHEN 'request' THEN '/requests/' || r.number
           WHEN 'request_comment' THEN '/requests/' || rr.number || '#c-' || rc.id
         END AS path
       FROM content_flags f JOIN users u ON u.id = f.flagger_id
         LEFT JOIN issues i ON f.target_kind = 'issue' AND i.id = f.target_id
         LEFT JOIN tools t1 ON t1.id = i.tool_id LEFT JOIN namespaces n1 ON n1.id = t1.namespace_id
         LEFT JOIN issue_comments ic ON f.target_kind = 'comment' AND ic.id = f.target_id LEFT JOIN issues ii ON ii.id = ic.issue_id
         LEFT JOIN tools t2 ON t2.id = ii.tool_id LEFT JOIN namespaces n2 ON n2.id = t2.namespace_id
         LEFT JOIN tool_requests r ON f.target_kind = 'request' AND r.id = f.target_id
         LEFT JOIN request_comments rc ON f.target_kind = 'request_comment' AND rc.id = f.target_id LEFT JOIN tool_requests rr ON rr.id = rc.request_id
       WHERE f.status = 'open' AND f.created_at < ? ORDER BY (f.reason = 'personal_data') DESC, f.created_at DESC LIMIT 100`,
    ).bind(before).all<{ id: string; target_kind: string; target_id: string; reason: string; note: string | null; created_at: number; flagger: string; text: string; moderation: string | null; path: string | null }>()).results;
    return c.json({
      flags: flags.map(({ text, ...f }) => ({ ...f, body_html: renderPost(text.slice(0, 2000), true) })),
      next_before: flags.length === 100 ? flags.at(-1)!.created_at : null,
    });
  });

  app.post("/moderation/users/:handle/timeout", async (c) => {
    const u = await requireModerator(c.env, c.get("user"));
    const b = await body<{ days: number; reason: string }>(c);
    const until = await timeout(c.env, u, c.req.param("handle"), Number(b.days ?? 7), typeof b.reason === "string" ? b.reason.slice(0, 200) : "");
    return c.json({ handle: c.req.param("handle"), posting_blocked_until: until });
  });

  // ---------- roles (admins) and reports that become issues (reviewers) ----------

  app.get("/admin/community/roles", async (c) => {
    requireAdmin(c);
    const rows = (await c.env.DB.prepare(
      `SELECT u.handle, u.login, r.role, r.note, r.granted_at, g.handle AS granted_by FROM community_roles r JOIN users u ON u.id = r.user_id
       LEFT JOIN users g ON g.id = r.granted_by ORDER BY r.granted_at DESC LIMIT 500`,
    ).all()).results;
    c.header("Cache-Control", "private, no-store");
    return c.json({ roles: rows });
  });

  app.post("/admin/community/roles", async (c) => {
    const admin = requireAdmin(c);
    const b = await body<{ handle: string; role: string; note: string }>(c);
    if (b.role !== "triager" && b.role !== "reviewer") apiError(400, "invalid_body", "role must be triager or reviewer");
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 300) : "";
    if (!note) apiError(400, "invalid_body", "say why in {note}");
    const target = await c.env.DB.prepare(`SELECT id FROM users WHERE handle = ? AND banned_at IS NULL`).bind(String(b.handle ?? "")).first<{ id: string }>();
    if (!target) apiError(404, "user_not_found", `nobody is called ${b.handle}`);
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO community_roles (user_id, role, granted_by, note, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note`)
        .bind(target.id, b.role, admin.id, note, Date.now()),
      audit(c.env.DB, admin.id, "user", "role.grant", "user", target.id, { role: b.role, note }),
    ]);
    await notify(c.env, [target.id], {
      kind: "role", scope: "account", summary: `You are now a ${b.role} on OTInstaller: thank you for helping`, path: "/docs/community", actor_id: admin.id,
    });
    return c.json({ handle: b.handle, role: b.role }, 201);
  });

  app.delete("/admin/community/roles/:handle/:role", async (c) => {
    const admin = requireAdmin(c);
    const target = await c.env.DB.prepare(`SELECT id FROM users WHERE handle = ?`).bind(c.req.param("handle")).first<{ id: string }>();
    if (!target) apiError(404, "user_not_found", `nobody is called ${c.req.param("handle")}`);
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM community_roles WHERE user_id = ? AND role = ?`).bind(target.id, c.req.param("role")),
      audit(c.env.DB, admin.id, "user", "role.revoke", "user", target.id, { role: c.req.param("role") }),
    ]);
    return c.json({ revoked: true });
  });

  // A private "broken" report a reviewer decides the public should see, rewritten by them, with no reporter attached.
  app.post("/admin/reports/:id/publish-issue", async (c) => {
    const reviewer: User = requireReviewer(c);
    const r = await c.env.DB.prepare(`SELECT id, tool_id, reason FROM reports WHERE id = ?`).bind(c.req.param("id")).first<{ id: string; tool_id: string; reason: string }>();
    if (!r) apiError(404, "report_not_found", "no such report");
    if (r.reason !== "broken") apiError(409, "invalid_state", "only broken reports can become public issues");
    const b = await body<{ title: string; body: string }>(c);
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const text = typeof b.body === "string" ? b.body.trim() : "";
    if (title.length < 5 || text.length < 10) apiError(400, "invalid_body", "send {title, body} written for the public");
    const out = await fileSystemIssue(c.env, r.tool_id, "broken", { title, markdown: text }, `report:${r.id}`, "report");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE reports SET status = 'actioned', action = 'published_issue', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).bind(reviewer.id, Date.now(), r.id),
      audit(c.env.DB, reviewer.id, "user", "report.actioned", "report", r.id, { action: "published_issue", issue: out.number }),
    ]);
    return c.json(out, 201);
  });
}
