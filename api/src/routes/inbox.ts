// A person's notifications: the inbox, their notification settings (per kind, the inbox and how often email comes, and
// the address it goes to; /me/email-prefs is the older form), what they follow (packages, publishers and input types),
// and the one-click unsubscribe links in community emails. Writing and delivering items live in ../inbox.ts; following
// one package is in ./community.ts beside its issues.
import type { Context } from "hono";
import schema from "../../../spec/schema/v1.json";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { requireUser } from "./auth";
import { emailPrefs, hiddenScopes, notificationSettings, saveEmailPrefs, saveNotificationSettings, unsubscribe, visibleScopeSql } from "../inbox";

export function inboxRoutes(app: App) {
  // Newest first, 50 at a time; ?unread=1 lists only what is unread. Kinds the person keeps out of their inbox are left
  // out of the list and the count.
  app.get("/me/inbox", async (c) => {
    const u = requireUser(c);
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const onlyUnread = c.req.query("unread") === "1" || c.req.query("unread") === "true";
    const visible = visibleScopeSql(await hiddenScopes(c.env, u.id));
    const [items, unread] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, kind, scope, summary, path, created_at, read_at FROM inbox WHERE user_id = ? AND created_at < ? AND ${visible.sql}${onlyUnread ? " AND read_at IS NULL" : ""}
         ORDER BY created_at DESC LIMIT 50`,
      ).bind(u.id, before, ...visible.binds).all<{ id: string; kind: string; scope: string; summary: string; path: string; created_at: number; read_at: number | null }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND read_at IS NULL AND ${visible.sql}`).bind(u.id, ...visible.binds).first<{ n: number }>(),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ items: items.results, unread: unread?.n ?? 0, next_before: items.results.length === 50 ? items.results.at(-1)!.created_at : null });
  });

  // Marks the given items read, or all of them.
  app.post("/me/inbox/read", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 100) : null;
    const now = Date.now();
    if (ids && ids.length) {
      await c.env.DB.prepare(`UPDATE inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`).bind(now, u.id, ...ids).run();
    } else {
      await c.env.DB.prepare(`UPDATE inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(now, u.id).run();
    }
    return c.json({ read: true });
  });

  // Per kind, whether items show in the inbox and how often they are emailed, and which sign-in account's address
  // gets the emails (with the addresses to choose from).
  app.get("/me/notification-settings", async (c) => {
    const u = requireUser(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await notificationSettings(c.env, u.id));
  });

  app.put("/me/notification-settings", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const settings = await saveNotificationSettings(c.env, u.id, b);
    c.header("Cache-Control", "private, no-store");
    return c.json(settings);
  });

  app.get("/me/email-prefs", async (c) => {
    const u = requireUser(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await emailPrefs(c.env, u.id));
  });

  // The packages the person follows, newest first, with each one's latest version and how much of it reaches them.
  app.get("/me/follows", async (c) => {
    const u = requireUser(c);
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const rows = (await c.env.DB.prepare(
      `SELECT n.name || '/' || t.name AS ref, t.kind, t.status, v.version AS latest_version, f.level, f.created_at AS followed_at
       FROM package_follows f JOIN tools t ON t.id = f.tool_id JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN versions v ON v.id = t.latest_version_id
       WHERE f.user_id = ? AND f.created_at < ? ORDER BY f.created_at DESC LIMIT 100`,
    ).bind(u.id, before).all<{ ref: string; kind: string; status: string; latest_version: string | null; level: string; followed_at: number }>()).results;
    // Publishers and input types are few; they come whole on the first page.
    const others = before === Number.MAX_SAFE_INTEGER
      ? (await c.env.DB.prepare(`SELECT kind, target, created_at FROM follows WHERE user_id = ? ORDER BY created_at DESC`).bind(u.id)
        .all<{ kind: "publisher" | "input"; target: string; created_at: number }>()).results
      : [];
    c.header("Cache-Control", "private, no-store");
    return c.json({
      follows: rows, next_before: rows.length === 100 ? rows.at(-1)!.followed_at : null,
      publishers: others.filter((f) => f.kind === "publisher").map((f) => ({ name: f.target, followed_at: f.created_at })),
      inputs: others.filter((f) => f.kind === "input").map((f) => ({ type: f.target, followed_at: f.created_at })),
    });
  });

  // ---------- following a publisher or an input type ----------

  // Whether the signed-in person follows a publisher (every new version and new package) or an input type (new
  // packages that take it).
  app.get("/me/follows/:kind/:target", async (c) => {
    const u = requireUser(c);
    const { kind, target } = await followTarget(c, false);
    const f = await c.env.DB.prepare(`SELECT created_at FROM follows WHERE user_id = ? AND kind = ? AND target = ?`).bind(u.id, kind, target).first<{ created_at: number }>();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: !!f, followed_at: f?.created_at ?? null });
  });

  app.put("/me/follows/:kind/:target", async (c) => {
    const u = requireUser(c);
    const { kind, target } = await followTarget(c, true);
    // Following again what you already follow answers as before, even at the limit.
    const mine = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM follows WHERE user_id = ? AND NOT (kind = ? AND target = ?)`)
      .bind(u.id, kind, target).first<{ n: number }>())?.n ?? 0;
    if (mine >= MAX_FOLLOWS) apiError(429, "too_many_follows", `you follow ${MAX_FOLLOWS} publishers and input types already`, "stop following some in your notification settings");
    await c.env.DB.prepare(`INSERT INTO follows (user_id, kind, target, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(u.id, kind, target, Date.now()).run();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: true });
  });

  // Unfollowing works for a publisher that is gone since.
  app.delete("/me/follows/:kind/:target", async (c) => {
    const u = requireUser(c);
    const { kind, target } = await followTarget(c, false);
    await c.env.DB.prepare(`DELETE FROM follows WHERE user_id = ? AND kind = ? AND target = ?`).bind(u.id, kind, target).run();
    c.header("Cache-Control", "private, no-store");
    return c.json({ following: false });
  });

  app.put("/me/email-prefs", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    return c.json(await saveEmailPrefs(c.env, u.id, b));
  });

  // One-click unsubscribe (RFC 8058): mail clients POST to the List-Unsubscribe URL; the site's /unsubscribe page posts
  // the same fields. A GET only shows that page, so link scanners can't unsubscribe anyone.
  app.post("/unsubscribe", async (c) => {
    const q = c.req.query();
    const form = c.req.header("content-type")?.includes("application/json") ? await c.req.json<Record<string, string>>().catch(() => ({}) as Record<string, string>) : {};
    const u = form.u ?? q.u ?? "";
    const s = form.s ?? q.s ?? "";
    const t = form.t ?? q.t ?? "";
    if (!(await unsubscribe(c.env, u, s, t))) apiError(400, "invalid_unsubscribe_link", "this unsubscribe link is not valid", "change your email settings at https://otinstaller.com/settings/notifications");
    c.header("Cache-Control", "private, no-store");
    return c.json({ unsubscribed: s });
  });

  app.get("/unsubscribe", (c) => c.redirect(`${c.env.SITE_URL}/unsubscribe?${new URL(c.req.url).searchParams}`, 302));
}

/** The input types a tool or guide can take; the parameter types (string, integer, boolean, enum) aren't followable. */
const FOLLOWABLE_INPUTS = new Set((schema.$defs.inputType.enum as string[]).filter((t) => !["string", "integer", "boolean", "enum"].includes(t)));

/** Publishers and input types one person may follow. */
const MAX_FOLLOWS = 200;

/** The publisher or input type a follow route names; a new follow needs a publisher that is live. */
async function followTarget(c: Context<AppEnv>, live: boolean): Promise<{ kind: "publisher" | "input"; target: string }> {
  const kind = c.req.param("kind");
  const target = c.req.param("target")!;
  if (kind === "input") {
    if (!FOLLOWABLE_INPUTS.has(target)) apiError(404, "input_type_not_found", `${target} is not an input type tools take`);
    return { kind, target };
  }
  if (kind !== "publisher") apiError(404, "not_found", "you can follow a publisher or an input type here; follow a package on its page");
  if (live) {
    const n = await c.env.DB.prepare(`SELECT status FROM namespaces WHERE name = ?`).bind(target).first<{ status: string }>();
    if (!n || n.status !== "active") apiError(404, "namespace_not_found", `${target} is not a publisher in the registry`);
  }
  return { kind, target };
}
