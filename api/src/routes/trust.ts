// Owner actions (yank, deprecate), reviewer actions (remove, reports, audit log), admin bans, public reports
// and the transparency list.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError, rateLimited, windowRetry } from "../lib/errors";
import { audit, requireUser } from "./auth";
import { requireMember } from "./sources";
import { requireAdmin, requireReviewer } from "./review";
import { cached } from "../catalog";
import { fileReport, overLimit, REMOVAL_CATEGORIES, REPORT_REASONS, removeVersion, setYanked, toolByRef, transparency, type ToolRef } from "../trust";
import { sendEmail, staffEmails, templates } from "../notify";

async function body<T>(c: Context<AppEnv>): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({}) as Partial<T>);
}

async function tool(c: Context<AppEnv>): Promise<ToolRef> {
  const { ns, name } = c.req.param() as { ns: string; name: string };
  const t = await toolByRef(c.env, ns, name);
  if (!t) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  return t;
}

function text(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) apiError(400, "invalid_body", `send {${field}}`);
  return s.slice(0, max);
}

export function trustRoutes(app: App) {
  // ---------- owners ----------

  for (const [path, yanked] of [["yank", true], ["unyank", false]] as const) {
    app.post(`/tools/:ns/:name/:version/${path}`, async (c) => {
      const t = await tool(c);
      const u = await requireMember(c, t.namespace_id);
      const version = c.req.param("version");
      const r = await setYanked(c.env, u.id, t, version, yanked);
      if (!r.ok) apiError(409, "invalid_state", `${t.namespace}/${t.name} ${version} is ${r.status ?? "not a version"}; only ${yanked ? "published" : "yanked"} versions can be ${path}ed`);
      return c.json({ ref: `${t.namespace}/${t.name}`, version, status: r.status });
    });
  }

  app.post("/tools/:ns/:name/deprecate", async (c) => {
    const t = await tool(c);
    const u = await requireMember(c, t.namespace_id);
    const b = await body<{ message: string; replacement: string }>(c);
    const message = text(b.message, "message", 500);
    const replacement = text(b.replacement, "replacement", 100, false);
    if (replacement && !(await toolByRef(c.env, ...(replacement.split("/") as [string, string])))) {
      apiError(400, "invalid_replacement", `${replacement} is not in the registry`, "give the replacement as namespace/name");
    }
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE tools SET status = 'deprecated', deprecated_message = ?, deprecated_replacement = ? WHERE id = ? AND status != 'removed'`)
        .bind(message, replacement || null, t.id),
      audit(c.env.DB, u.id, "user", "tool.deprecate", "tool", t.id, { message, replacement }),
    ]);
    return c.json({ status: "deprecated", message, replacement: replacement || null });
  });

  app.delete("/tools/:ns/:name/deprecate", async (c) => {
    const t = await tool(c);
    const u = await requireMember(c, t.namespace_id);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE tools SET status = 'active', deprecated_message = NULL, deprecated_replacement = NULL WHERE id = ? AND status = 'deprecated'`).bind(t.id),
      audit(c.env.DB, u.id, "user", "tool.undeprecate", "tool", t.id),
    ]);
    return c.json({ status: "active" });
  });

  // ---------- reports ----------

  // Anonymous reports are allowed: 5 per hour per IP (hashed), 20 per day per signed-in user.
  app.post("/tools/:ns/:name/reports", async (c) => {
    const t = await tool(c);
    if (t.status === "removed") apiError(410, "tool_removed", `${t.namespace}/${t.name} was already removed`);
    const b = await body<{ reason: string; details: string; version: string }>(c);
    const reason = text(b.reason, "reason", 20);
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) apiError(400, "invalid_reason", `reason must be one of: ${REPORT_REASONS.join(", ")}`);
    const details = text(b.details, "details", 4000, reason !== "broken");
    const user = c.get("user");
    const limited = user
      ? await overLimit(c.env, "report-user", user.id, 20, 86_400_000)
      : await overLimit(c.env, "report-ip", c.req.header("cf-connecting-ip") ?? "unknown", 5, 3_600_000);
    if (limited) {
      rateLimited("too_many_reports", user ? "at most 20 reports a day" : "at most 5 reports an hour from one address", "write to abuse@otinstaller.com",
        windowRetry(user ? 86_400_000 : 3_600_000), user ? 20 : 5, user ? 86400 : 3600);
    }
    const version = b.version
      ? await c.env.DB.prepare(`SELECT id FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, String(b.version)).first<{ id: string }>()
      : null;
    const id = await fileReport(c.env, t, user?.id ?? null, reason, details, version?.id ?? null);
    const ref = `${t.namespace}/${t.name}${b.version ? `@${b.version}` : ""}`;
    // Malware reports reach reviewers at once (24-hour target); others wait for the daily digest.
    if (reason === "malware") {
      await sendEmail(c.env, { to: await staffEmails(c.env, "reviewers"), kind: "report", key: `report:${id}`, ...templates.reportReceived(c.env, ref, reason, details, id) });
    }
    return c.json({ id, status: "open", note: "Thank you. A reviewer will look at it; malware reports within 24 hours, others within 72." }, 201);
  });

  app.get("/admin/reports", async (c) => {
    requireReviewer(c);
    const status = c.req.query("status") ?? "open";
    if (!["open", "actioned", "dismissed", "all"].includes(status)) apiError(400, "invalid_parameter", "status must be open, actioned, dismissed or all");
    const rows = await c.env.DB.prepare(
      `SELECT r.id, n.name AS namespace, t.name, v.version, r.reason, r.details, r.status, r.action, r.resolution_note, r.created_at, r.resolved_at,
         u.login AS reporter, ru.login AS resolved_by
       FROM reports r JOIN tools t ON t.id = r.tool_id JOIN namespaces n ON n.id = t.namespace_id
       LEFT JOIN versions v ON v.id = r.version_id LEFT JOIN users u ON u.id = r.reporter_id LEFT JOIN users ru ON ru.id = r.resolved_by
       WHERE (? = 'all' OR r.status = ?) ORDER BY (r.reason = 'malware') DESC, r.created_at LIMIT 200`,
    ).bind(status, status).all<any>();
    return c.json({ reports: rows.results.map((r) => ({ ...r, ref: `${r.namespace}/${r.name}` })) });
  });

  // Resolving records what was done; the action itself (remove, suspend, ban) is its own call.
  app.post("/admin/reports/:id/resolve", async (c) => {
    const reviewer = requireReviewer(c);
    const b = await body<{ status: string; action: string; note: string }>(c);
    const status = b.status === "dismissed" ? "dismissed" : b.status === "actioned" ? "actioned" : null;
    if (!status) apiError(400, "invalid_body", "send {status: 'actioned' | 'dismissed', action?, note}");
    const action = text(b.action, "action", 40, status === "actioned");
    const note = text(b.note, "note", 2000, false);
    const r = await c.env.DB.prepare(`SELECT id, tool_id FROM reports WHERE id = ?`).bind(c.req.param("id")).first<{ id: string; tool_id: string }>();
    if (!r) apiError(404, "report_not_found", "no such report");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE reports SET status = ?, action = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
        .bind(status, action || null, note || null, reviewer.id, Date.now(), r.id),
      audit(c.env.DB, reviewer.id, "user", `report.${status}`, "report", r.id, { action, note }),
    ]);
    return c.json({ id: r.id, status });
  });

  // ---------- removals and bans ----------

  const removal = async (c: Context<AppEnv>, version: string | null) => {
    const reviewer = requireReviewer(c);
    const t = await tool(c);
    const b = await body<{ category: string; reason: string; suspend_namespace: boolean }>(c);
    const category = text(b.category, "category", 20);
    if (!(REMOVAL_CATEGORIES as readonly string[]).includes(category)) apiError(400, "invalid_category", `category must be one of: ${REMOVAL_CATEGORIES.join(", ")}`);
    const reason = text(b.reason, "reason", 2000);
    const r = await removeVersion(c.env, reviewer.id, t, version, category, reason, b.suspend_namespace === true);
    if (!r.ok) apiError(409, "invalid_state", r.error);
    return c.json({ ref: `${t.namespace}/${t.name}`, version, status: "removed", namespace_suspended: b.suspend_namespace === true });
  };
  app.post("/admin/tools/:ns/:name/:version/remove", (c) => removal(c, c.req.param("version")));
  app.post("/admin/tools/:ns/:name/remove", (c) => removal(c, null));

  app.post("/admin/users/:login/ban", async (c) => {
    const admin = requireAdmin(c);
    const reason = text((await body<{ reason: string }>(c)).reason, "reason", 2000);
    const u = await c.env.DB.prepare(`SELECT id, is_admin FROM users WHERE login = ? OR id = ?`).bind(c.req.param("login"), c.req.param("login")).first<{ id: string; is_admin: number }>();
    if (!u) apiError(404, "user_not_found", "no such user");
    if (u.is_admin) apiError(409, "cannot_ban_admin", "remove the admin role first");
    const now = Date.now();
    // Banned users lose every session and token at once.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET banned_at = ? WHERE id = ?`).bind(now, u.id),
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(u.id),
      c.env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, u.id),
      audit(c.env.DB, admin.id, "user", "user.ban", "user", u.id, { reason }),
    ]);
    return c.json({ id: u.id, banned: true });
  });

  app.get("/admin/audit-log", async (c) => {
    requireReviewer(c);
    const before = Number(c.req.query("before") ?? Date.now() + 1);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
    const rows = await c.env.DB.prepare(
      `SELECT a.id, a.actor_kind, u.login AS actor, a.action, a.target_kind, a.target_id, a.metadata_json, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.created_at < ? ORDER BY a.created_at DESC LIMIT ?`,
    ).bind(before, limit).all<any>();
    const entries = rows.results.map((r) => ({ ...r, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null, metadata_json: undefined }));
    return c.json({ entries, next_before: entries.length === limit ? entries.at(-1)!.created_at : undefined });
  });

  // ---------- transparency ----------

  app.get("/removed", async (c) => {
    cached(c, 600);
    return c.json(await transparency(c.env));
  });

  // Who am I to this package: lets the site show owner controls without exposing membership publicly.
  app.get("/tools/:ns/:name/permissions", async (c) => {
    const t = await tool(c);
    const u = requireUser(c);
    const m = await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(t.namespace_id, u.id).first<{ role: string }>();
    c.header("Cache-Control", "private, no-store");
    return c.json({ owner: !!m || !!u.is_admin, reviewer: !!u.is_reviewer || !!u.is_admin, admin: !!u.is_admin });
  });
}
