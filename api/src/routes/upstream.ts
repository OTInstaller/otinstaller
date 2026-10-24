// Upstream watcher routes: the public summary of community wrappers behind their upstream, the staff view with pin
// overrides, a check-now button and every wrapper's latest bump, merging and releasing a bump pull request (or
// releasing a failed one again), and the maintainers' switch for releasing bumps on their own (UPSTREAM_WATCH=auto).
// The same bump routes serve first-party tools' dependency updates and rebuilds (#0). Logic lives in ../upstream.ts,
// ../bumps.ts and ../build-watch.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { audit, requireUser } from "./auth";
import { requireAdmin, requireReviewer } from "./review";
import { checkUpstream, publicWatch, watchMode, type WatchRow, type WatchState } from "../upstream";
import { autoReleaseAt, canRelease, currentBump, releaseBumpAs, type BumpRow } from "../bumps";
import { dependencyAutoAt, type DependencyRow } from "../build-watch";

type Joined = WatchRow & { ns: string; name: string };

/** What a package page shows of a bump; the error text only to the people who can release it. */
const bumpView = (b: BumpRow, withError: boolean) => ({
  kind: b.kind, version: b.version, number: b.pr_number, url: b.url, status: b.status, released_version: b.released_version, auto: b.auto === 1,
  merged_at: b.merged_at, released_at: b.released_at, attempts: b.attempts,
  ...(withError ? { error_code: b.error_code, error: b.error, run_url: b.run_url } : {}),
});
const FROM = `FROM upstream_watch w JOIN tools t ON t.id = w.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE t.status != 'removed'`;

async function wrapper(c: Context<AppEnv>): Promise<{ id: string }> {
  const t = await c.env.DB.prepare(`SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ? AND t.upstream_url IS NOT NULL`)
    .bind(c.req.param("ns"), c.req.param("name")).first<{ id: string }>();
  if (!t) apiError(404, "tool_not_found", "no community wrapper by that name");
  return t;
}

/** A package the community bot can bump (a wrapper, or a first-party tool with a repository), with what releasing it needs. */
async function bumpTool(c: Context<AppEnv>) {
  const t = await c.env.DB.prepare(
    `SELECT t.id, t.name, n.name AS ns, t.namespace_id, t.upstream_url, s.path AS wrapper, v.manifest_json
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id LEFT JOIN sources s ON s.tool_id = t.id
     WHERE n.name = ? AND t.name = ? AND (t.upstream_url IS NOT NULL OR s.path IS NOT NULL) AND t.status != 'removed'`,
  ).bind(c.req.param("ns"), c.req.param("name")).first<{ id: string; name: string; ns: string; namespace_id: string; upstream_url: string | null; wrapper: string | null; manifest_json: string }>();
  if (!t) apiError(404, "tool_not_found", "no package by that name with a repository");
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

  // ---------- bump pull requests (the package's maintainers and reviewers) ----------

  // The package's current bump (open, being released, failed, or released in the last two weeks), whether the
  // signed-in person may release it, and in auto mode when it goes out on its own.
  app.get("/packages/:ns/:name/bump", async (c) => {
    const u = requireUser(c);
    const t = await bumpTool(c);
    const [bump, who, watch, auto, depRows] = await Promise.all([
      currentBump(c.env, t.id), canRelease(c.env, u, t),
      c.env.DB.prepare(`SELECT latest_at FROM upstream_watch WHERE tool_id = ?`).bind(t.id).first<{ latest_at: number | null }>(),
      c.env.DB.prepare(`SELECT auto_release FROM tools WHERE id = ?`).bind(t.id).first<{ auto_release: number }>(),
      c.env.DB.prepare(`SELECT package, latest_at FROM dependency_watch WHERE tool_id = ?`).bind(t.id).all<Pick<DependencyRow, "package" | "latest_at">>().then((r) => r.results),
    ]);
    const mode = watchMode(c.env);
    const canRel = who.maintainer || who.reviewer;
    const autoAt = !bump || bump.status !== "open" || mode !== "auto" || !auto?.auto_release ? null
      : bump.kind === "dependency" ? dependencyAutoAt(depRows, bump) : autoReleaseAt({ latest_at: watch?.latest_at ?? null }, bump);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      bump: bump ? { ...bumpView(bump, canRel), auto_release_at: autoAt } : null,
      can_release: canRel,
      auto_release: !!auto?.auto_release,
      mode,
    });
  });

  // Merges and releases an open bump, or releases a failed one again (without merging again); #0 is a failed rebuild.
  app.post("/packages/:ns/:name/pulls/:number/release", async (c) => {
    const u = requireUser(c);
    const t = await bumpTool(c);
    const n = Number(c.req.param("number"));
    if (!Number.isInteger(n) || n < 0) apiError(400, "invalid_parameter", "the pull request number is a whole number");
    const out = await releaseBumpAs(c.env, u, t, n);
    c.header("Cache-Control", "private, no-store");
    return c.json({ merged: true, upstream_version: out.version, version: out.released, attempt: out.attempt });
  });

  // Whether the registry may release this package's pin-only bumps on its own (UPSTREAM_WATCH=auto).
  app.put("/packages/:ns/:name/auto-release", async (c) => {
    const u = requireUser(c);
    const t = await bumpTool(c);
    const who = await canRelease(c.env, u, t);
    if (!who.maintainer && !who.reviewer) apiError(403, "not_package_maintainer", "only the package's maintainers and reviewers can change this");
    const b = await c.req.json<{ enabled?: unknown }>().catch(() => ({}) as { enabled?: unknown });
    if (typeof b.enabled !== "boolean") apiError(400, "invalid_body", "send {enabled: true} or {enabled: false}");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE tools SET auto_release = ? WHERE id = ?`).bind(b.enabled ? 1 : 0, t.id),
      audit(c.env.DB, u.id, "user", b.enabled ? "bump.auto_on" : "bump.auto_off", "tool", t.id),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ auto_release: b.enabled });
  });

  // ---------- staff ----------

  app.get("/admin/upstream", async (c) => {
    requireReviewer(c);
    const state = c.req.query("state");
    const bumpStatus = c.req.query("bump");
    if (bumpStatus && !["open", "merged", "released", "failed", "closed"].includes(bumpStatus)) apiError(400, "invalid_parameter", "bump is open, merged, released, failed or closed");
    // Each wrapper's latest bump comes along; ?bump=failed lists only the wrappers whose latest bump failed.
    const latestBump = `(SELECT b.version FROM bump_prs b WHERE b.tool_id = w.tool_id ORDER BY b.created_at DESC LIMIT 1)`;
    const where = `${state ? " AND w.state = ?" : ""}${bumpStatus ? ` AND (SELECT b.status FROM bump_prs b WHERE b.tool_id = w.tool_id ORDER BY b.created_at DESC LIMIT 1) = ?` : ""}`;
    const rows = (await c.env.DB.prepare(`SELECT w.*, n.name AS ns, t.name, t.auto_release, ${latestBump} AS bump_version ${FROM}${where} ORDER BY w.state, n.name, t.name`)
      .bind(...(state ? [state] : []), ...(bumpStatus ? [bumpStatus] : [])).all<Joined & { auto_release: number; bump_version: string | null }>()).results;
    const bumps = new Map<string, BumpRow>();
    for (const r of rows.filter((r) => r.bump_version)) {
      const b = await c.env.DB.prepare(`SELECT * FROM bump_prs WHERE tool_id = ? AND version = ?`).bind(r.tool_id, r.bump_version).first<BumpRow>();
      if (b) bumps.set(r.tool_id, b);
    }
    c.header("Cache-Control", "private, no-store");
    return c.json({
      mode: watchMode(c.env),
      watches: rows.map((r) => ({
        ref: `${r.ns}/${r.name}`, upstream: r.upstream_path, provider: r.provider, ...publicWatch(r), pin_kind: r.pin_kind, upstream_license: r.upstream_license, error: r.error,
        override: r.override_json ? JSON.parse(r.override_json) : null, changed_at: r.changed_at, auto_release: r.auto_release === 1,
        bump: bumps.has(r.tool_id) ? bumpView(bumps.get(r.tool_id)!, true) : null,
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
