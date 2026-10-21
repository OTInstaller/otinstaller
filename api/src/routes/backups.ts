// Backups: the scanner's signed uploads and its report, public wheel copies, owners' restore and opt-out,
// admins' legal holds and manual backups, and the restore drill's report. The logic is in ../backups.ts.
import type { Context } from "hono";
import type { App, AppEnv, Env } from "../env";
import { apiError } from "../lib/errors";
import { objectSignature } from "../lib/presign";
import { requireSecret } from "../env";
import { requireUser } from "./auth";
import { requireAdmin } from "./review";
import { toolByRef, type ToolRef } from "../trust";
import {
  BackupError, backupSummary, completeDrill, completeRun, dispatchBackups, MAX_BUNDLE_BYTES, MAX_WHEEL_BYTES,
  releasePlan, restoreLink, setGitBackups, setLegalHold, type ReportedItem,
} from "../backups";

function bearer(c: Context<AppEnv>): string {
  const h = c.req.header("authorization") ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!t) apiError(401, "unauthenticated", "missing token");
  return t;
}

function rethrow(e: unknown): never {
  if (e instanceof BackupError) apiError(e.status, e.code, e.message);
  throw e;
}

async function tool(c: Context<AppEnv>): Promise<ToolRef> {
  const { ns, name } = c.req.param() as { ns: string; name: string };
  const t = await toolByRef(c.env, ns, name);
  if (!t) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  return t;
}

/** Restores and backup settings are for the namespace's owners (and admins), not every publisher. */
async function requireOwner(c: Context<AppEnv>, namespaceId: string) {
  const u = requireUser(c);
  if (u.is_admin) return u;
  const m = await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(namespaceId, u.id).first<{ role: string }>();
  if (m?.role !== "owner") apiError(403, "forbidden", "only the package's owners can do this");
  return u;
}

const LIMIT_FOR_PREFIX: [string, number][] = [["git/", MAX_BUNDLE_BYTES], ["wheels/", MAX_WHEEL_BYTES]];

async function checkObjectUrl(c: Context<AppEnv>, method: "GET" | "PUT"): Promise<string> {
  const key = decodeURIComponent(new URL(c.req.url).pathname.replace(/^\/v1\/internal\/backups\/objects\//, ""));
  const expires = Number(c.req.query("expires"));
  const sig = c.req.query("sig") ?? "";
  if (c.req.query("method") !== method || !Number.isFinite(expires) || expires * 1000 < Date.now()) apiError(403, "url_expired", "this link has expired");
  if (key.includes("..") || !LIMIT_FOR_PREFIX.some(([p]) => key.startsWith(p))) apiError(403, "invalid_signature", "not a backup object");
  const want = await objectSignature(requireSecret(c.env, "TOKEN_ENC_KEY"), method, key, expires);
  if (sig.length !== want.length || sig !== want) apiError(403, "invalid_signature", "the link's signature does not match");
  return key;
}

export async function wheelResponse(env: Env, ns: string, name: string, version: string) {
  const row = await env.DB.prepare(
    `SELECT b.location, b.filename, b.sha256, b.size_bytes FROM backups b JOIN versions v ON v.id = b.version_id JOIN tools t ON t.id = v.tool_id
     JOIN namespaces n ON n.id = t.namespace_id
     WHERE n.name = ? AND t.name = ? AND v.version = ? AND v.status IN ('published', 'yanked') AND t.status != 'removed'
       AND b.kind = 'wheel' AND b.status = 'stored' AND b.visibility = 'public' AND b.delete_after IS NULL`,
  ).bind(ns, name, version).first<{ location: string; filename: string | null; sha256: string | null; size_bytes: number | null }>();
  if (!row) apiError(404, "backup_not_found", `no public wheel backup for ${ns}/${name} ${version}`);
  const obj = await env.BACKUPS.get(row.location);
  if (!obj) apiError(404, "backup_not_found", `no public wheel backup for ${ns}/${name} ${version}`);
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename="${row.filename ?? `${name}-${version}.whl`}"`,
      ...(row.sha256 ? { "X-Checksum-Sha256": row.sha256 } : {}),
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export function backupRoutes(app: App) {
  // ---------- signed object URLs (when R2 API credentials are not configured) ----------
  app.put("/internal/backups/objects/*", async (c) => {
    const key = await checkObjectUrl(c, "PUT");
    const max = LIMIT_FOR_PREFIX.find(([p]) => key.startsWith(p))![1];
    const len = Number(c.req.header("content-length") ?? NaN);
    if (!Number.isFinite(len)) apiError(400, "length_required", "send Content-Length");
    if (len > max) apiError(413, "too_large", `at most ${max} bytes`);
    await c.env.BACKUPS.put(key, c.req.raw.body!);
    return c.body(null, 200);
  });
  app.get("/internal/backups/objects/*", async (c) => {
    const key = await checkObjectUrl(c, "GET");
    const obj = await c.env.BACKUPS.get(key);
    if (!obj) apiError(404, "backup_not_found", "no such object");
    return new Response(obj.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(obj.size) } });
  });

  // ---------- the scanner's report ----------
  app.post("/internal/backups/:run", async (c) => {
    const token = bearer(c);
    const body = await c.req.json<{ items?: ReportedItem[] }>().catch(() => null);
    if (!body || !Array.isArray(body.items) || body.items.length > 10) apiError(400, "invalid_body", "send {items: [{id, status: 'stored' | 'too_large' | 'failed', size_bytes, sha256, ...}]}");
    for (const i of body.items) {
      if (typeof i?.id !== "string" || !["stored", "too_large", "failed"].includes(i.status)) apiError(400, "invalid_body", "each item needs an id and a status");
    }
    return c.json(await completeRun(c.env, c.req.param("run"), token, body.items).catch(rethrow));
  });

  app.post("/internal/drills/:id", async (c) => {
    const token = bearer(c);
    const body = await c.req.json<{ result?: string; detail?: string; checks?: unknown }>().catch(() => ({}));
    return c.json(await completeDrill(c.env, c.req.param("id"), token, body).catch(rethrow));
  });

  // ---------- installs: the wheel copy (public, OSI-approved licenses only) ----------
  app.get("/tools/:ns/:name/:version/wheel/:file", (c) => wheelResponse(c.env, c.req.param("ns"), c.req.param("name"), c.req.param("version")));

  // ---------- owners ----------
  app.get("/me/backups", async (c) => {
    const u = requireUser(c);
    const tools = (await c.env.DB.prepare(
      `SELECT t.id, n.name AS namespace, t.name, t.status, m.role, s.provider, s.url, s.sync_status FROM tools t JOIN namespaces n ON n.id = t.namespace_id
       JOIN namespace_members m ON m.namespace_id = n.id AND m.user_id = ? LEFT JOIN sources s ON s.tool_id = t.id
       WHERE t.latest_version_id IS NOT NULL ORDER BY n.name, t.name LIMIT 200`,
    ).bind(u.id).all<{ id: string; namespace: string; name: string; status: string; role: string; provider: string | null; url: string | null; sync_status: string | null }>()).results;
    const packages = [];
    for (const t of tools) {
      const s = await backupSummary(c.env, t.id);
      packages.push({
        ref: `${t.namespace}/${t.name}`, role: t.role, status: t.status, source: t.url ? { provider: t.provider, url: t.url, sync_status: t.sync_status } : null,
        git_backups: s.git_backups, latest_bundle: s.latest_bundle,
        mirrored: s.backups.some((b: any) => b.kind === "image" && b.status === "stored") || s.backups.some((b: any) => b.kind === "wheel" && b.status === "stored"),
      });
    }
    return c.json({ packages });
  });

  app.get("/packages/:ns/:name/backups", async (c) => {
    const t = await tool(c);
    await requireOwner(c, t.namespace_id);
    return c.json({ ref: `${t.namespace}/${t.name}`, ...(await backupSummary(c.env, t.id)) });
  });

  app.patch("/packages/:ns/:name/backups", async (c) => {
    const t = await tool(c);
    const u = await requireOwner(c, t.namespace_id);
    const body = await c.req.json<{ git_backups?: unknown }>().catch(() => ({} as { git_backups?: unknown }));
    if (typeof body.git_backups !== "boolean") apiError(400, "invalid_body", "send {git_backups: true | false}");
    await setGitBackups(c.env, u.id, t.id, body.git_backups);
    return c.json({ ref: `${t.namespace}/${t.name}`, git_backups: body.git_backups });
  });

  app.post("/packages/:ns/:name/backups/restore", async (c) => {
    const t = await tool(c);
    const u = await requireOwner(c, t.namespace_id);
    return c.json(await restoreLink(c.env, t.id, u.id).catch(rethrow));
  });

  // ---------- admins ----------
  app.post("/admin/tools/:ns/:name/legal-hold", async (c) => {
    const admin = requireAdmin(c);
    const t = await tool(c);
    const body = await c.req.json<{ hold?: unknown; reason?: unknown }>().catch(() => ({} as { hold?: unknown; reason?: unknown }));
    if (typeof body.hold !== "boolean") apiError(400, "invalid_body", "send {hold: true | false, reason}");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (body.hold && !reason) apiError(400, "invalid_body", "a legal hold needs a reason");
    await setLegalHold(c.env, admin.id, t.id, body.hold, reason);
    return c.json({ ref: `${t.namespace}/${t.name}`, legal_hold: body.hold });
  });

  // Backs up a version now. With {"dispatch": false} the job is returned instead of sent to registry-ops,
  // so it can be run by hand: `python ops/scanner/scan.py job.json`.
  app.post("/admin/tools/:ns/:name/:version/backup", async (c) => {
    requireAdmin(c);
    const t = await tool(c);
    const v = await c.env.DB.prepare(`SELECT id FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, c.req.param("version")).first<{ id: string }>();
    if (!v) apiError(404, "version_not_found", `${t.namespace}/${t.name} has no version ${c.req.param("version")}`);
    const body = await c.req.json<{ dispatch?: boolean }>().catch(() => ({} as { dispatch?: boolean }));
    const plan = await releasePlan(c.env, v.id, "manual");
    if (!plan) return c.json({ status: "nothing_to_do", message: "the version is not published, or everything is already backed up" });
    if (body.dispatch === false) return c.json({ status: "created", job: { backup: { jobs: [plan] } } });
    await dispatchBackups(c.env, [plan]);
    return c.json({ status: "dispatched", run_id: plan.run_id });
  });
}
