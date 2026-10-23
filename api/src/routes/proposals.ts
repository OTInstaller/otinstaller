// Change proposal routes: a community wrapper's proposals and each one's page (public), the wrapper's files for its
// maintainers to start from, proposing, editing and withdrawing a change, reviewers' decisions, and every open
// proposal across the registry for reviewers. Rules live in ../proposals.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { communityRoles } from "../community";
import { botToken } from "../submissions";
import {
  canPropose, createProposal, currentFiles, nextVersion, OPEN_STATUSES, proposalByNumber, reviewProposal, updateProposal, withdrawProposal, wrapperByRef,
  type Decision, type ProposalInput, type ProposalRow, type Wrapper,
} from "../proposals";

type Row = ProposalRow & { handle: string | null; login: string | null; profile_hidden: number | null; reviewer: string | null };

const COLS = `p.*, u.handle, u.login, u.profile_hidden, r.handle AS reviewer`;
const FROM = `FROM change_proposals p LEFT JOIN users u ON u.id = p.proposer_id LEFT JOIN users r ON r.id = p.reviewer_id`;

function summaryOf(p: Row) {
  return {
    number: p.pr_number, title: p.title, status: p.status, version: p.version, released_version: p.released_version, url: p.url,
    proposed_by: p.handle || p.login ? { handle: p.handle ?? p.login!.toLowerCase(), profile: !p.profile_hidden } : null,
    files: Object.keys(JSON.parse(p.files_json) as Record<string, string>), created_at: p.created_at, updated_at: p.updated_at,
  };
}

function detailOf(p: Row) {
  return {
    ...summaryOf(p), note: p.note, builds: !!p.builds, checks: JSON.parse(p.checks_json) as { code: string; message: string }[],
    decision_note: p.decision_note, decided_at: p.decided_at, reviewed_by: p.reviewer,
  };
}

async function wrapper(c: Context<AppEnv>): Promise<Wrapper> {
  return wrapperByRef(c.env, c.req.param("ns")!, c.req.param("name")!);
}

async function proposal(c: Context<AppEnv>, t: Wrapper): Promise<ProposalRow> {
  const n = Number(c.req.param("number"));
  const p = Number.isInteger(n) && n > 0 ? await proposalByNumber(c.env, t.id, n) : null;
  if (!p) apiError(404, "proposal_not_found", `${t.ns}/${t.name} has no change proposal #${c.req.param("number")}`);
  return p;
}

const full = async (c: Context<AppEnv>, id: string) => (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE p.id = ?`).bind(id).first<Row>())!;

export function proposalRoutes(app: App) {
  // ---------- reading (public, cached) ----------

  // Every open change proposal across the registry, for reviewers; closed ones with status=closed.
  app.get("/proposals", async (c) => {
    const status = c.req.query("status") ?? "open";
    if (!["open", "closed", "all"].includes(status)) apiError(400, "invalid_parameter", "status must be open, closed or all");
    const before = Number(c.req.query("before") ?? 0) || null;
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
    const where = [`t.status != 'removed'`, status === "open" ? `p.status IN (${open})` : status === "closed" ? `p.status NOT IN (${open})` : null,
      before ? `p.updated_at < ?` : null].filter(Boolean).join(" AND ");
    const rows = (await c.env.DB.prepare(
      `SELECT ${COLS}, n.name AS ns, t.name AS tool ${FROM} JOIN tools t ON t.id = p.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE ${where} ORDER BY p.updated_at DESC LIMIT 51`,
    ).bind(...(before ? [before] : [])).all<Row & { ns: string; tool: string }>()).results;
    const page = rows.slice(0, 50);
    cached(c, 60);
    return c.json({ proposals: page.map((p) => ({ ref: `${p.ns}/${p.tool}`, ...summaryOf(p) })), next_before: rows.length > 50 ? page.at(-1)!.updated_at : null });
  });

  app.get("/packages/:ns/:name/proposals", async (c) => {
    const t = await wrapper(c);
    const rows = (await c.env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE p.tool_id = ? ORDER BY p.created_at DESC LIMIT 50`).bind(t.id).all<Row>()).results;
    cached(c, 60);
    return c.json({ ref: `${t.ns}/${t.name}`, proposals: rows.map(summaryOf) });
  });

  app.get("/packages/:ns/:name/proposals/:number", async (c) => {
    const t = await wrapper(c);
    const p = await proposal(c, t);
    cached(c, 60);
    return c.json({ ref: `${t.ns}/${t.name}`, proposal: detailOf(await full(c, p.id)) });
  });

  // ---------- the signed-in person ----------

  // What the signed-in person may do on a proposal; the proposer and reviewers also get its files.
  app.get("/packages/:ns/:name/proposals/:number/viewer", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    const p = await proposal(c, t);
    const isProposer = p.proposer_id === u.id;
    const reviewer = (await communityRoles(c.env, u)).has("reviewer");
    const open = OPEN_STATUSES.includes(p.status);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      is_proposer: isProposer, can_review: reviewer && !isProposer && open, can_edit: isProposer && open, can_withdraw: (isProposer || !!u.is_admin) && open,
      files: isProposer || reviewer ? JSON.parse(p.files_json) : undefined,
    });
  });

  // The wrapper's files on its main branch, for a maintainer to start a proposal from.
  app.get("/packages/:ns/:name/files", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    if (!(await canPropose(c.env, u, t))) apiError(403, "not_package_maintainer", `only the maintainers of ${t.ns}/${t.name} and reviewers can propose changes to it`);
    const files = await currentFiles(await botToken(c.env), t);
    const v = await nextVersion(c.env, t.id);
    c.header("Cache-Control", "private, no-store");
    return c.json({ ref: `${t.ns}/${t.name}`, repo: t.wrapper, files, builds: files.Dockerfile !== null, latest_version: v.latest, next_version: v.next });
  });

  // ---------- proposing (maintainers and reviewers) ----------

  app.post("/packages/:ns/:name/proposals", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    const b = await c.req.json<ProposalInput>().catch(() => ({}) as ProposalInput);
    const p = await createProposal(c.env, u, t, b);
    c.header("Cache-Control", "private, no-store");
    return c.json({ proposal: detailOf(await full(c, p.id)), url: `${c.env.SITE_URL}/${t.ns}/${t.name}/changes/${p.pr_number}` }, 201);
  });

  app.patch("/packages/:ns/:name/proposals/:number", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    const p = await proposal(c, t);
    const b = await c.req.json<ProposalInput>().catch(() => ({}) as ProposalInput);
    const after = await updateProposal(c.env, u, t, p, b);
    c.header("Cache-Control", "private, no-store");
    return c.json({ proposal: detailOf(await full(c, after.id)) });
  });

  app.delete("/packages/:ns/:name/proposals/:number", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    const p = await proposal(c, t);
    await withdrawProposal(c.env, u, t, p);
    c.header("Cache-Control", "private, no-store");
    return c.json({ number: p.pr_number, status: "withdrawn" });
  });

  // ---------- deciding (staff and community reviewers, never the proposer) ----------

  app.post("/packages/:ns/:name/proposals/:number/review", async (c) => {
    const u = requireUser(c);
    const t = await wrapper(c);
    const p = await proposal(c, t);
    const b = await c.req.json<{ decision?: string; note?: string }>().catch(() => ({}) as { decision?: string; note?: string });
    const after = await reviewProposal(c.env, u, t, p, String(b.decision) as Decision, b.note);
    c.header("Cache-Control", "private, no-store");
    return c.json({ proposal: detailOf(await full(c, after.id)) });
  });
}
