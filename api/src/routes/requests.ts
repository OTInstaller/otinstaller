// Tool request routes: the public board and request pages with their discussion, making a request, votes, replies,
// following, triagers' decisions and locks, and what the signed-in person may do on a request. Rules live in
// ../requests.ts; editing, deleting and moderating replies share ../community.ts with issue comments.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { communityRoles, deletePost, editPost, EDIT_WINDOW, renderPost } from "../community";
import {
  ACTIVE_STATUSES, addRequestComment, createRequest, DECLINE_CODES, followRequest, indexable, REQUEST_STATUSES, requestByNumber, setRequestLocked, setRequestStatus,
  vote, type RequestRow, type RequestStatus,
} from "../requests";

/** People new to the community (under a week) have their links shown as text. */
const NEW_AUTHOR = 7 * 86_400_000;

type Person = { handle: string | null; login: string | null; avatar_url: string | null; profile_hidden: number | null };
type Row = RequestRow & Person & { ns: string | null; tool: string | null; decider: string | null };

const COLS = `r.*, u.handle, u.login, u.avatar_url, u.profile_hidden, n.name AS ns, t.name AS tool, d.handle AS decider`;
const FROM = `FROM tool_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN tools t ON t.id = r.tool_id LEFT JOIN namespaces n ON n.id = t.namespace_id
  LEFT JOIN users d ON d.id = r.decided_by`;

function person(p: Person) {
  if (!p.handle && !p.login) return null;
  return { handle: p.handle ?? p.login!.toLowerCase(), avatar_url: p.profile_hidden ? null : p.avatar_url, profile: !p.profile_hidden };
}

function summaryOf(r: Row) {
  return {
    number: r.number, provider: r.provider, repo: r.repo_path, name: r.repo_path.split("/").pop(), url: r.url, description: r.description, license: r.license,
    upstream_stars: r.upstream_stars, status: r.status, decline_code: r.decline_code, votes: r.vote_count, comments: r.comment_count, requested_by: person(r),
    tool: r.ns && r.tool ? `${r.ns}/${r.tool}` : null, otlite: r.otlite_name, created_at: r.created_at, updated_at: r.updated_at, indexable: indexable(r),
  };
}

function detailOf(r: Row) {
  return {
    id: r.id, ...summaryOf(r), note: r.note, decision_note: r.decision_note, decided_at: r.decided_at, decided_by: r.decider, dropped_reason: r.dropped_reason,
    pushed_at: r.pushed_at, locked: !!r.locked_at,
  };
}

type Reply = { id: string; author_kind: string; role_badge: string | null; body_md: string; edited_at: number | null; created_at: number; author_created: number | null } & Person;

/** A request's visible replies, oldest first, rendered like issue comments. */
async function replies(c: Context<AppEnv>, requestId: string) {
  const now = Date.now();
  const rows = (await c.env.DB.prepare(
    `SELECT c.id, c.author_kind, c.role_badge, c.body_md, c.edited_at, c.created_at, u.handle, u.login, u.avatar_url, u.profile_hidden, u.created_at AS author_created
     FROM request_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.request_id = ? AND c.moderation = 'visible' AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 500`,
  ).bind(requestId).all<Reply>()).results;
  return rows.map((cm) => ({
    id: cm.id,
    author: cm.author_kind === "system" ? { system: true as const, handle: "otinstaller" } : person(cm) ?? { handle: "deleted", avatar_url: null, profile: false },
    role: cm.role_badge, created_at: cm.created_at, edited_at: cm.edited_at,
    body_html: renderPost(cm.body_md, cm.author_kind !== "system" && !cm.role_badge && (cm.author_created ?? 0) > now - NEW_AUTHOR),
  }));
}

async function reply(c: Context<AppEnv>, r: RequestRow): Promise<string> {
  const id = c.req.param("id")!;
  const found = await c.env.DB.prepare(`SELECT 1 FROM request_comments WHERE id = ? AND request_id = ?`).bind(id, r.id).first();
  if (!found) apiError(404, "comment_not_found", `request #${r.number} has no such reply`);
  return id;
}

async function request(c: Context<AppEnv>): Promise<RequestRow> {
  const n = Number(c.req.param("number"));
  const r = Number.isInteger(n) && n > 0 ? await requestByNumber(c.env, n) : null;
  if (!r || r.moderation === "hidden") apiError(404, "request_not_found", `there is no request #${c.req.param("number")}`);
  return r;
}

export function requestRoutes(app: App) {
  // ---------- reading (public, cached) ----------

  app.get("/requests", async (c) => {
    const status = c.req.query("status") ?? "active";
    if (status !== "active" && status !== "all" && !(REQUEST_STATUSES as readonly string[]).includes(status)) {
      apiError(400, "invalid_parameter", `status must be active, all or one of: ${REQUEST_STATUSES.join(", ")}`);
    }
    const sort = c.req.query("sort") ?? "votes";
    if (sort !== "votes" && sort !== "new") apiError(400, "invalid_parameter", "sort must be votes or new");
    // The cursor is "<votes>.<number>" when sorted by votes, else "<number>".
    const before = c.req.query("before");
    const [bv, bn] = (before ?? "").split(".").map(Number);
    if (before && (sort === "votes" ? !Number.isInteger(bv) || !Number.isInteger(bn) : !Number.isInteger(bv))) apiError(400, "invalid_parameter", "before is the next_before of the previous page");
    const statuses = status === "active" ? ACTIVE_STATUSES : status === "all" ? null : [status];
    const where = [`r.moderation = 'visible'`, statuses ? `r.status IN (${statuses.map((s) => `'${s}'`).join(", ")})` : null,
      before ? (sort === "votes" ? `(r.vote_count < ?1 OR (r.vote_count = ?1 AND r.number < ?2))` : `r.number < ?1`) : null].filter(Boolean).join(" AND ");
    const binds = before ? (sort === "votes" ? [bv, bn] : [bv]) : [];
    const [rows, counts] = await Promise.all([
      c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY ${sort === "votes" ? "r.vote_count DESC, r.number DESC" : "r.number DESC"} LIMIT 51`)
        .bind(...binds).all<Row>(),
      c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM tool_requests WHERE moderation = 'visible' GROUP BY status`).all<{ status: RequestStatus; n: number }>(),
    ]);
    const page = rows.results.slice(0, 50);
    const last = page.at(-1);
    cached(c, 120);
    return c.json({
      requests: page.map(summaryOf),
      counts: Object.fromEntries(REQUEST_STATUSES.map((s) => [s, counts.results.find((x) => x.status === s)?.n ?? 0])),
      next_before: rows.results.length > 50 && last ? (sort === "votes" ? `${last.vote_count}.${last.number}` : String(last.number)) : null,
    });
  });

  app.get("/requests/:number", async (c) => {
    const r = await request(c);
    if (r.moderation !== "visible") apiError(404, "request_not_found", `there is no request #${r.number}`);
    const row = (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE r.id = ?`).bind(r.id).first<Row>())!;
    const comments = await replies(c, r.id);
    cached(c, 60);
    return c.json({ request: detailOf(row), comments });
  });

  // What the signed-in person may do on a request: whether they voted, asked for it, or can decide it.
  app.get("/requests/:number/viewer", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const [voted, sub, held, mine] = await Promise.all([
      c.env.DB.prepare(`SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ?`).bind(r.id, u.id).first(),
      c.env.DB.prepare(`SELECT muted FROM request_subscriptions WHERE request_id = ? AND user_id = ?`).bind(r.id, u.id).first<{ muted: number }>(),
      c.env.DB.prepare(`SELECT id, body_md, created_at FROM request_comments WHERE request_id = ? AND author_id = ? AND moderation = 'held' AND deleted_at IS NULL ORDER BY created_at`)
        .bind(r.id, u.id).all<{ id: string; body_md: string; created_at: number }>(),
      c.env.DB.prepare(`SELECT id, created_at FROM request_comments WHERE request_id = ? AND author_id = ? AND moderation = 'visible' AND deleted_at IS NULL`).bind(r.id, u.id)
        .all<{ id: string; created_at: number }>(),
    ]);
    const triager = (await communityRoles(c.env, u)).has("triager");
    const now = Date.now();
    c.header("Cache-Control", "private, no-store");
    return c.json({
      voted: !!voted, is_requester: r.requested_by === u.id, can_decide: triager, held: r.moderation === "held",
      note: r.moderation === "held" && r.requested_by === u.id ? r.note : undefined,
      subscribed: !!sub && !sub.muted, locked: !!r.locked_at, can_reply: r.moderation === "visible" && (!r.locked_at || triager),
      editable_comments: mine.results.filter((m) => now - m.created_at < EDIT_WINDOW).map((m) => m.id),
      held_comments: held.results.map((h) => ({ id: h.id, created_at: h.created_at, body_html: renderPost(h.body_md, true) })),
    });
  });

  // ---------- taking part (signed in, scope feedback) ----------

  app.post("/requests", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<{ repo?: unknown; note?: unknown }>().catch(() => ({}) as { repo?: unknown; note?: unknown });
    const { row, notes } = await createRequest(c.env, u, b);
    const full = (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE r.id = ?`).bind(row.id).first<Row>())!;
    c.header("Cache-Control", "private, no-store");
    return c.json({ request: detailOf(full), held: row.moderation === "held", notes, url: `${c.env.SITE_URL}/requests/${row.number}` }, 201);
  });

  for (const method of ["put", "delete"] as const) {
    app[method]("/requests/:number/vote", async (c) => {
      const u = requireUser(c);
      const r = await request(c);
      c.header("Cache-Control", "private, no-store");
      return c.json({ number: r.number, ...(await vote(c.env, u, r, method === "put")) });
    });
  }

  // ---------- the discussion (signed in, scope feedback) ----------

  app.post("/requests/:number/comments", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const b = await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown });
    const out = await addRequestComment(c.env, r, u, typeof b.body === "string" ? b.body : "");
    c.header("Cache-Control", "private, no-store");
    return c.json(out, 201);
  });

  app.patch("/requests/:number/comments/:id", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const id = await reply(c, r);
    const b = await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown });
    return c.json(await editPost(c.env, "request_comment", id, u, { body: typeof b.body === "string" ? b.body : undefined }));
  });

  app.delete("/requests/:number/comments/:id", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    await deletePost(c.env, "request_comment", await reply(c, r), u);
    return c.json({ deleted: true });
  });

  for (const method of ["put", "delete"] as const) {
    app[method]("/requests/:number/subscription", async (c) => {
      const u = requireUser(c);
      const r = await request(c);
      await followRequest(c.env, r, u, method === "put");
      return c.json({ subscribed: method === "put" });
    });
  }

  // ---------- decisions (triagers and staff; the requester may withdraw) ----------

  app.post("/requests/:number/status", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const b = await c.req.json<{ status?: string; decline_code?: string; note?: string; tool?: string }>().catch(() => ({}) as Record<string, string>);
    if (b.decline_code && !(DECLINE_CODES as readonly string[]).includes(b.decline_code)) apiError(400, "invalid_body", `decline_code must be one of: ${DECLINE_CODES.join(", ")}`);
    const after = await setRequestStatus(c.env, u, r, String(b.status) as RequestStatus, { decline_code: b.decline_code, note: b.note, tool: b.tool });
    c.header("Cache-Control", "private, no-store");
    return c.json({ number: after.number, status: after.status, decline_code: after.decline_code });
  });

  app.post("/requests/:number/lock", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const b = await c.req.json<{ locked?: boolean }>().catch(() => ({}) as { locked?: boolean });
    await setRequestLocked(c.env, r, u, b.locked !== false);
    return c.json({ number: r.number, locked: b.locked !== false });
  });
}
