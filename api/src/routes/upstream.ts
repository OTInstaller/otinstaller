// Upstream watcher routes: the public summary of community wrappers behind their upstream, and the staff view with
// pin overrides and a check-now button. Logic lives in ../upstream.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { audit } from "./auth";
import { requireAdmin, requireReviewer } from "./review";
import { checkUpstream, publicWatch, watchMode, type WatchRow, type WatchState } from "../upstream";

type Joined = WatchRow & { ns: string; name: string };
const FROM = `FROM upstream_watch w JOIN tools t ON t.id = w.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE t.status != 'removed'`;

async function wrapper(c: Context<AppEnv>): Promise<{ id: string }> {
  const t = await c.env.DB.prepare(`SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ? AND t.upstream_url IS NOT NULL`)
    .bind(c.req.param("ns"), c.req.param("name")).first<{ id: string }>();
  if (!t) apiError(404, "tool_not_found", "no community wrapper by that name");
  return t;
}

export function upstreamRoutes(app: App) {
  // How the community wrappers stand against their upstream projects, and which are behind.
  app.get("/upstream/summary", async (c) => {
    const rows = (await c.env.DB.prepare(`SELECT w.*, n.name AS ns, t.name ${FROM} ORDER BY w.latest_at DESC`).all<Joined>()).results;
    const counts: Record<WatchState, number> = { current: 0, behind: 0, unknown: 0, archived: 0, gone: 0, license_changed: 0, renamed: 0, error: 0 };
    for (const r of rows) counts[r.state]++;
    cached(c, 3600);
    return c.json({
      mode: watchMode(c.env),
      counts,
      behind: rows.filter((r) => r.state === "behind" && !r.commits_behind).map((r) => ({ ref: `${r.ns}/${r.name}`, ...publicWatch(r) })),
      checked_at: rows.reduce((m, r) => Math.max(m, r.checked_at ?? 0), 0) || null,
    });
  });

  // ---------- staff ----------

  app.get("/admin/upstream", async (c) => {
    requireReviewer(c);
    const state = c.req.query("state");
    const rows = (await c.env.DB.prepare(`SELECT w.*, n.name AS ns, t.name ${FROM}${state ? " AND w.state = ?" : ""} ORDER BY w.state, n.name, t.name`)
      .bind(...(state ? [state] : [])).all<Joined>()).results;
    c.header("Cache-Control", "private, no-store");
    return c.json({
      mode: watchMode(c.env),
      watches: rows.map((r) => ({
        ref: `${r.ns}/${r.name}`, upstream: r.upstream_path, ...publicWatch(r), pin_kind: r.pin_kind, upstream_license: r.upstream_license, error: r.error,
        override: r.override_json ? JSON.parse(r.override_json) : null, changed_at: r.changed_at,
      })),
    });
  });

  // When the pin can't be read from the Dockerfile: say which upstream release the package pins, or clear it.
  app.put("/admin/upstream/:ns/:name", async (c) => {
    const admin = requireAdmin(c);
    const t = await wrapper(c);
    const b = await c.req.json<{ pin_kind?: string; pinned?: string; package?: string; clear?: boolean }>().catch(() => ({}) as Record<string, never>);
    const override = b.clear ? null : (() => {
      if (typeof b.pinned !== "string" || !/^[\w.\-+]{1,64}$/.test(b.pinned)) apiError(400, "invalid_body", "send {pinned: \"1.2.3\"} (and pin_kind, package), or {clear: true}");
      return JSON.stringify({ pin_kind: typeof b.pin_kind === "string" ? b.pin_kind.slice(0, 20) : "override", pinned: b.pinned, package: typeof b.package === "string" ? b.package.slice(0, 100) : undefined });
    })();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO upstream_watch (tool_id, override_json) VALUES (?, ?) ON CONFLICT (tool_id) DO UPDATE SET override_json = excluded.override_json`).bind(t.id, override),
      audit(c.env.DB, admin.id, "user", "upstream.override", "tool", t.id, { override }),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ override: override ? JSON.parse(override) : null, watch: publicWatch((await checkUpstream(c.env, t.id))!) });
  });

  app.post("/admin/upstream/:ns/:name/check", async (c) => {
    requireReviewer(c);
    const t = await wrapper(c);
    const row = await checkUpstream(c.env, t.id);
    c.header("Cache-Control", "private, no-store");
    return c.json({ watch: row ? publicWatch(row) : null, error: row?.error ?? null });
  });
}
