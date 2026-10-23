// Tool request routes: the public board and request pages, making a request, votes, triagers' decisions and what the
// signed-in person may do on a request. Rules live in ../requests.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { communityRoles } from "../community";
import {
  ACTIVE_STATUSES, createRequest, DECLINE_CODES, indexable, REQUEST_STATUSES, requestByNumber, setRequestStatus, vote, type RequestRow, type RequestStatus,
} from "../requests";

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
    upstream_stars: r.upstream_stars, status: r.status, decline_code: r.decline_code, votes: r.vote_count, requested_by: person(r),
    tool: r.ns && r.tool ? `${r.ns}/${r.tool}` : null, otlite: r.otlite_name, created_at: r.created_at, updated_at: r.updated_at, indexable: indexable(r),
  };
}

function detailOf(r: Row) {
  return {
    ...summaryOf(r), note: r.note, decision_note: r.decision_note, decided_at: r.decided_at, decided_by: r.decider, dropped_reason: r.dropped_reason, pushed_at: r.pushed_at,
  };
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
    cached(c, 60);
    return c.json({ request: detailOf(row) });
  });

  // What the signed-in person may do on a request: whether they voted, asked for it, or can decide it.
  app.get("/requests/:number/viewer", async (c) => {
    const u = requireUser(c);
    const r = await request(c);
    const voted = !!(await c.env.DB.prepare(`SELECT 1 FROM request_votes WHERE request_id = ? AND user_id = ?`).bind(r.id, u.id).first());
    c.header("Cache-Control", "private, no-store");
    return c.json({
      voted, is_requester: r.requested_by === u.id, can_decide: (await communityRoles(c.env, u)).has("triager"), held: r.moderation === "held",
      note: r.moderation === "held" && r.requested_by === u.id ? r.note : undefined,
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
}
