// Claims of community wrappers and transfers between namespaces (logic in ../transfers.ts).
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { requireUser } from "./auth";
import { requireAdmin } from "./review";
import { toolByRef } from "../trust";
import {
  acceptTransfer, CLAIM_FILE, completeTransfer, declineTransfer, offerTransfer, startClaim, transferById, TransferError, transferView, verifyClaim,
  type Transfer,
} from "../transfers";

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TransferError) apiError(e.status, e.code, e.message, e.hint);
    throw e;
  }
}

async function involved(c: Context<AppEnv>): Promise<Transfer> {
  const u = requireUser(c);
  const tr = await transferById(c.env, c.req.param("id")!);
  if (!tr) apiError(404, "transfer_not_found", "no such transfer");
  const member = await c.env.DB.prepare(`SELECT 1 FROM namespace_members WHERE user_id = ? AND namespace_id IN (?, ?)`)
    .bind(u.id, tr.from_namespace_id, tr.to_namespace_id).first();
  if (!member && tr.requested_by !== u.id && !u.is_admin && !u.is_reviewer) apiError(404, "transfer_not_found", "no such transfer");
  return tr;
}

export function transferRoutes(app: App) {
  app.post("/tools/:ns/:name/claim", async (c) => {
    const u = requireUser(c);
    const { ns, name } = c.req.param();
    const t = await toolByRef(c.env, ns, name);
    if (!t || t.status === "removed") apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({}) as { to?: string });
    const claim = await wrap(() => startClaim(c.env, u.id, t, to));
    // Verify straight away: a linked admin account is usually enough.
    const tr = await wrap(async () => verifyClaim(c.env, (await transferById(c.env, claim.id))!));
    return c.json({
      ...(await transferView(c.env, tr)),
      claim_token: claim.token,
      instructions: tr.status === "verified"
        ? "Verified through your linked account. An admin completes the transfer, usually within 1 business day."
        : `Either sign in with an account that administers ${claim.upstream}, or commit a file named ${CLAIM_FILE} containing only the claim token to its default branch, then verify again.`,
    }, 201);
  });

  app.post("/tools/:ns/:name/transfer", async (c) => {
    const u = requireUser(c);
    const { ns, name } = c.req.param();
    const t = await toolByRef(c.env, ns, name);
    if (!t || t.status === "removed") apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
    const { to } = await c.req.json<{ to?: string }>().catch(() => ({}) as { to?: string });
    if (!to) apiError(400, "invalid_body", "send {to: 'namespace'}");
    const id = await wrap(() => offerTransfer(c.env, u.id, !!u.is_admin, t, to));
    return c.json(await transferView(c.env, (await transferById(c.env, id))!), 201);
  });

  app.get("/transfers/:id", async (c) => c.json(await transferView(c.env, await involved(c))));

  app.post("/transfers/:id/verify", async (c) => {
    const tr = await involved(c);
    return c.json(await transferView(c.env, await wrap(() => verifyClaim(c.env, tr))));
  });

  app.post("/transfers/:id/accept", async (c) => {
    const u = requireUser(c);
    const tr = await involved(c);
    const done = await wrap(() => acceptTransfer(c.env, u.id, tr));
    return c.json({ ...(await transferView(c.env, (await transferById(c.env, tr.id))!)), ...done });
  });

  app.post("/transfers/:id/decline", async (c) => {
    const u = requireUser(c);
    const tr = await involved(c);
    await wrap(() => declineTransfer(c.env, u.id, !!u.is_admin, tr));
    return c.json({ id: tr.id, status: "declined" });
  });

  app.get("/me/transfers", async (c) => {
    const u = requireUser(c);
    const rows = (await c.env.DB.prepare(
      `SELECT DISTINCT t.* FROM transfers t LEFT JOIN namespace_members m ON m.namespace_id IN (t.from_namespace_id, t.to_namespace_id) AND m.user_id = ?
       WHERE (t.requested_by = ? OR m.user_id IS NOT NULL) AND t.status IN ('pending', 'verified', 'accepted') ORDER BY t.created_at DESC`,
    ).bind(u.id, u.id).all<Transfer>()).results;
    return c.json({ transfers: await Promise.all(rows.map((r) => transferView(c.env, r))) });
  });

  // ---------- admins ----------

  app.get("/admin/transfers", async (c) => {
    requireAdmin(c);
    const status = c.req.query("status") ?? "verified";
    const rows = (await c.env.DB.prepare(`SELECT * FROM transfers WHERE (? = 'all' OR status = ?) ORDER BY tool_id, created_at LIMIT 200`)
      .bind(status, status).all<Transfer>()).results;
    // Competing claims on one package appear next to each other; the verified upstream admin wins, ties are reviewed by hand.
    return c.json({ transfers: await Promise.all(rows.map((r) => transferView(c.env, r))) });
  });

  app.post("/admin/transfers/:id/complete", async (c) => {
    const admin = requireAdmin(c);
    const tr = await transferById(c.env, c.req.param("id"));
    if (!tr) apiError(404, "transfer_not_found", "no such transfer");
    const done = await wrap(() => completeTransfer(c.env, admin.id, tr));
    return c.json({ id: tr.id, status: "completed", ...done });
  });
}
