// A person's notifications: the inbox, email preferences, and the one-click unsubscribe links in community emails.
// Writing and delivering items live in ../inbox.ts.
import type { App } from "../env";
import { apiError } from "../lib/errors";
import { requireUser } from "./auth";
import { PREFS, PREF_SCOPES, unsubscribe, type Pref } from "../inbox";

export function inboxRoutes(app: App) {
  app.get("/me/inbox", async (c) => {
    const u = requireUser(c);
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const [items, unread] = await Promise.all([
      c.env.DB.prepare(`SELECT id, kind, summary, path, created_at, read_at FROM inbox WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 50`)
        .bind(u.id, before).all<{ id: string; kind: string; summary: string; path: string; created_at: number; read_at: number | null }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND read_at IS NULL`).bind(u.id).first<{ n: number }>(),
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

  app.get("/me/email-prefs", async (c) => {
    const u = requireUser(c);
    const p = await c.env.DB.prepare(`SELECT community, owner_issues, releases FROM email_prefs WHERE user_id = ?`).bind(u.id).first<{ community: Pref; owner_issues: Pref; releases: Pref }>();
    c.header("Cache-Control", "private, no-store");
    return c.json({ community: p?.community ?? "immediate", owner_issues: p?.owner_issues ?? "immediate", releases: p?.releases ?? "immediate" });
  });

  // The packages the person follows for releases, newest first, with each one's latest version.
  app.get("/me/follows", async (c) => {
    const u = requireUser(c);
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const rows = (await c.env.DB.prepare(
      `SELECT n.name || '/' || t.name AS ref, t.kind, t.status, v.version AS latest_version, f.created_at AS followed_at
       FROM package_follows f JOIN tools t ON t.id = f.tool_id JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN versions v ON v.id = t.latest_version_id
       WHERE f.user_id = ? AND f.created_at < ? ORDER BY f.created_at DESC LIMIT 100`,
    ).bind(u.id, before).all<{ ref: string; kind: string; status: string; latest_version: string | null; followed_at: number }>()).results;
    c.header("Cache-Control", "private, no-store");
    return c.json({ follows: rows, next_before: rows.length === 100 ? rows.at(-1)!.followed_at : null });
  });

  app.put("/me/email-prefs", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    for (const k of PREF_SCOPES) {
      if (b[k] !== undefined && !PREFS.includes(b[k] as Pref)) apiError(400, "invalid_body", `${k} must be one of: ${PREFS.join(", ")}`);
    }
    const cur = await c.env.DB.prepare(`SELECT community, owner_issues, releases FROM email_prefs WHERE user_id = ?`).bind(u.id).first<{ community: Pref; owner_issues: Pref; releases: Pref }>();
    const next = {
      community: (b.community as Pref) ?? cur?.community ?? "immediate", owner_issues: (b.owner_issues as Pref) ?? cur?.owner_issues ?? "immediate",
      releases: (b.releases as Pref) ?? cur?.releases ?? "immediate",
    };
    await c.env.DB.prepare(
      `INSERT INTO email_prefs (user_id, community, owner_issues, releases, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET community = excluded.community, owner_issues = excluded.owner_issues, releases = excluded.releases,
         updated_at = excluded.updated_at`,
    ).bind(u.id, next.community, next.owner_issues, next.releases, Date.now()).run();
    return c.json(next);
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
