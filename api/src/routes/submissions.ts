// Community submission routes: the public list and pages, what the signed-in person may do, the submitter's changes
// and withdrawal, and reviewers' decisions. Submitting is POST /imports/:id/finish with mode "submit"
// (routes/imports.ts). Rules live in ../submissions.ts.
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { communityRoles } from "../community";
import { ImportProblem } from "../imports";
import { publishVersion } from "../scans";
import {
  OPEN_STATUSES, approveSubmission, decideSubmission, startSubmission, submissionByNumber, updateSubmission, withdrawSubmission, type SubmissionRow,
} from "../submissions";

/** Submission rules throw ImportProblem like the wizard does; they reach clients the same way. */
async function rules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ImportProblem) {
      const problems = (e as ImportProblem & { problems?: unknown[] }).problems;
      if (problems) throw new HTTPException(e.status, { res: Response.json({ error: { code: e.code, message: e.message, problems } }, { status: e.status }) });
      apiError(e.status, e.code, e.message, e.hint);
    }
    throw e;
  }
}

async function submission(c: Context<AppEnv>): Promise<SubmissionRow> {
  const n = Number(c.req.param("number"));
  const s = Number.isInteger(n) && n > 0 ? await submissionByNumber(c.env, n) : null;
  if (!s) apiError(404, "submission_not_found", `there is no submission #${c.req.param("number")}`);
  return s;
}

type Joined = SubmissionRow & { handle: string | null; reviewer: string | null; ns: string | null; tool: string | null; live: number | null; request_number: number | null };
const COLS = `s.*, COALESCE(u.handle, lower(u.login)) AS handle, COALESCE(r.handle, lower(r.login)) AS reviewer, n.name AS ns, t.name AS tool, t.latest_version_id IS NOT NULL AS live, q.number AS request_number`;
const FROM = `FROM wrapper_submissions s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewer_id LEFT JOIN tools t ON t.id = s.tool_id
  LEFT JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN tool_requests q ON q.id = s.request_id`;

function summaryOf(s: Joined) {
  return {
    number: s.number, name: s.name, upstream: { provider: s.provider, repo: s.upstream_path, url: s.upstream_url }, runtime: s.runtime, builds: !!s.builds,
    status: s.status, submitted_by: s.handle, wrapper_repo: s.wrapper_repo ? `https://github.com/${s.wrapper_repo}` : null,
    tool: s.ns && s.tool && s.live ? `${s.ns}/${s.tool}` : null, request: s.request_number, created_at: s.created_at, updated_at: s.updated_at,
  };
}

export function submissionRoutes(app: App) {
  app.get("/submissions", async (c) => {
    const status = c.req.query("status") ?? "open";
    if (!["open", "published", "closed", "all"].includes(status)) apiError(400, "invalid_parameter", "status must be open, published, closed or all");
    const before = Number(c.req.query("before") ?? 0) || null;
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
    const where = [status === "open" ? `s.status IN (${open})` : status === "published" ? `s.status = 'published'` : status === "closed" ? `s.status IN ('rejected', 'withdrawn')` : null,
      before ? `s.number < ?` : null].filter(Boolean).join(" AND ") || "1 = 1";
    const rows = (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY s.number DESC LIMIT 51`).bind(...(before ? [before] : [])).all<Joined>()).results;
    const page = rows.slice(0, 50);
    cached(c, 120);
    return c.json({ submissions: page.map(summaryOf), next_before: rows.length > 50 ? page.at(-1)!.number : null });
  });

  app.get("/submissions/:number", async (c) => {
    const s = await submission(c);
    const row = (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE s.id = ?`).bind(s.id).first<Joined>())!;
    // The scans of the latest release, for reviewers and the submitter.
    const v = s.tool_id
      ? await c.env.DB.prepare(`SELECT id, version, status, scan_status FROM versions WHERE tool_id = ? ORDER BY created_at DESC LIMIT 1`).bind(s.tool_id)
        .first<{ id: string; version: string; status: string; scan_status: string | null }>()
      : null;
    const scans = v
      ? (await c.env.DB.prepare(`SELECT kind, result, summary_json FROM scans WHERE version_id = ? ORDER BY ran_at`).bind(v.id).all<{ kind: string; result: string; summary_json: string | null }>()).results
      : [];
    const checks = JSON.parse(s.checks_json || "{}") as { flags?: unknown[]; dockerfile?: unknown[] };
    cached(c, 60);
    return c.json({
      submission: {
        ...summaryOf(row), manifest: JSON.parse(s.manifest_json), dockerfile: s.dockerfile, template_conformant: !!s.template_conformant,
        flags: checks.flags ?? [], dockerfile_checks: checks.dockerfile ?? [], released_version: s.released_version, decision_note: s.decision_note,
        reviewer: row.reviewer, error: s.error,
        release: v ? { version: v.version, status: v.status, scan_status: v.scan_status, scans: scans.map((x) => ({ kind: x.kind, result: x.result, summary: JSON.parse(x.summary_json ?? "null") })) } : null,
      },
    });
  });

  app.get("/submissions/:number/viewer", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    const reviewer = (await communityRoles(c.env, u)).has("reviewer");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      is_submitter: s.user_id === u.id, can_review: reviewer && s.user_id !== u.id,
      can_edit: s.user_id === u.id && ["submitted", "changes_requested", "failed"].includes(s.status),
    });
  });

  // ---------- the submitter ----------

  app.put("/submissions/:number", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    const b = await c.req.json<{ manifest?: unknown; dockerfile?: unknown }>().catch(() => ({}) as { manifest?: unknown; dockerfile?: unknown });
    const after = await rules(() => updateSubmission(c.env, u, s, b));
    c.header("Cache-Control", "private, no-store");
    return c.json({ number: after.number, status: after.status, version: (JSON.parse(after.manifest_json) as { version: string }).version });
  });

  app.post("/submissions/:number/withdraw", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    await withdrawSubmission(c.env, u, s);
    return c.json({ number: s.number, status: "withdrawn" });
  });

  // ---------- reviewers (staff and community reviewers, never the submitter) ----------

  const note = async (c: Context<AppEnv>) => {
    const b = await c.req.json<{ note?: unknown }>().catch(() => ({}) as { note?: unknown });
    return typeof b.note === "string" ? b.note.trim().slice(0, 2000) : "";
  };

  app.post("/submissions/:number/approve", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    await approveSubmission(c.env, u, s, await note(c), (id) => publishVersion(c.env, id));
    return c.json({ number: s.number, status: "published" });
  });

  app.post("/submissions/:number/request-changes", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    await decideSubmission(c.env, u, s, "changes_requested", await note(c));
    return c.json({ number: s.number, status: "changes_requested" });
  });

  app.post("/submissions/:number/reject", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    await decideSubmission(c.env, u, s, "rejected", await note(c));
    return c.json({ number: s.number, status: "rejected" });
  });

  // Starts the build of a Dockerfile that doesn't follow the template, once a reviewer has read it.
  app.post("/submissions/:number/start", async (c) => {
    const u = requireUser(c);
    const s = await submission(c);
    await startSubmission(c.env, u, s);
    return c.json({ number: s.number, status: "releasing" });
  });
}
