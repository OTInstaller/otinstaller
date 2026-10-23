// Publisher profile routes: the public profile, publisher list and activity under /namespaces, and the owner's profile
// settings under /me/namespaces/:ns/profile. Syncing, overrides and rendering live in ../profiles.ts.
import type { Context } from "hono";
import { deps, type App, type AppEnv } from "../env";
import { apiError, rateLimited, windowRetry } from "../lib/errors";
import { cached, LISTED, summary, SUMMARY_COLUMNS, VISIBLE, type SummaryRow } from "../catalog";
import { overLimit } from "../trust";
import { ACTIVITY } from "../activity";
import { audit, requireUser } from "./auth";
import * as github from "../hosts/github";
import { GITLAB, OWNER } from "../hosts/gitlab";
import { githubUserToken, gitlabToken } from "../hosts/repo";
import {
  effectiveProfile, hostsOf, MANUAL_PROFILE_SYNCS_PER_HOUR, MAX_ABOUT, MAX_PINS, namespaceByName, overrideValue, profileOf,
  publicHosts, renderAbout, syncProfile, PROFILE_FIELDS, type NamespaceRow,
} from "../profiles";

const PUBLIC_STATUSES = ["active", "pending_review"];

/** The namespace, for its owners (or an admin). Pending namespaces can be edited before review. */
async function ownedNamespace(c: Context<AppEnv>): Promise<{ ns: NamespaceRow; userId: string }> {
  const u = requireUser(c);
  const ns = await namespaceByName(c.env, c.req.param("ns")!);
  if (!ns || !PUBLIC_STATUSES.includes(ns.status)) apiError(404, "namespace_not_found", `${c.req.param("ns")} is not a registry namespace`);
  const m = await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(ns.id, u.id).first<{ role: string }>();
  if (m?.role !== "owner" && !u.is_admin) apiError(403, "forbidden", "only the namespace's owners can change its profile");
  return { ns, userId: u.id };
}

/** Everything the owner's Profile tab needs: host values, overrides, what the page shows, and sync state. */
async function ownerView(c: Context<AppEnv>, ns: NamespaceRow, userId: string) {
  const db = c.env.DB;
  const [p, hosts, accounts, packages] = await Promise.all([
    profileOf(c.env, ns.id),
    hostsOf(c.env, ns.id),
    db.prepare(`SELECT provider, login FROM accounts WHERE user_id = ? AND provider IN ('github', 'gitlab') ORDER BY provider`).bind(userId).all<{ provider: string; login: string }>(),
    db.prepare(`SELECT name, kind, summary FROM tools WHERE namespace_id = ? AND status != 'removed' ORDER BY name`).bind(ns.id).all<{ name: string; kind: string; summary: string }>(),
  ]);
  const custom = JSON.parse(p?.custom_json ?? "{}") as Record<string, unknown>;
  return {
    namespace: { name: ns.name, kind: ns.kind, provider: ns.provider, status: ns.status, verified: ns.verified === 1 },
    host: {
      display_name: p?.host_name ?? null, bio: p?.host_bio ?? null, location: p?.host_location ?? null, website: p?.host_website ?? null,
      company: p?.host_company ?? null, avatar_url: p?.host_avatar_url ?? null, socials: JSON.parse(p?.host_socials_json ?? "[]"),
      members: JSON.parse(p?.host_members_json ?? "[]").length,
    },
    custom,
    fields: PROFILE_FIELDS,
    effective: effectiveProfile(ns, p, hosts),
    about_md: p?.about_md ?? null,
    pins: JSON.parse(p?.pins_json ?? "[]") as string[],
    hide_details: p?.hide_details === 1,
    sync: { status: p?.sync_status ?? "never", error: p?.sync_error ?? null, synced_at: p?.synced_at ?? null },
    hosts: publicHosts(ns, p, hosts),
    accounts: accounts.results,
    packages: packages.results,
  };
}

async function loadJson(f: typeof fetch, url: string, headers: Record<string, string>): Promise<any | null> {
  const res = await f(url, { headers });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new github.HostError(`${url} answered ${res.status}`, res.status, res.status >= 500 || res.status === 429);
  return res.json();
}

/**
 * The account to show as a secondary host: the user's own account on that provider, or a GitHub org they administer or
 * a public GitLab group they own.
 */
async function secondaryAccount(c: Context<AppEnv>, userId: string, provider: "github" | "gitlab", path: string | undefined) {
  const acct = await c.env.DB.prepare(`SELECT provider_user_id, login FROM accounts WHERE user_id = ? AND provider = ?`).bind(userId, provider)
    .first<{ provider_user_id: string; login: string }>();
  const name = provider === "github" ? "GitHub" : "GitLab";
  if (!acct) apiError(400, "host_account_not_linked", `link your ${name} account first`, `sign in with ${name} from Settings: ${c.env.API_URL}/v1/auth/${provider}/login`);
  if (!path || path.toLowerCase() === acct.login.toLowerCase()) return { ownerId: acct.provider_user_id, login: acct.login, kind: "user" as const };
  if (!/^[A-Za-z0-9_.\-/]{1,200}$/.test(path)) apiError(400, "invalid_body", "account must be an org or group path such as acme or acme/osint");
  if (provider === "github") {
    const token = await githubUserToken(c.env, userId).catch(() => apiError(400, "host_account_not_linked", "link your GitHub account again", `sign in with GitHub: ${c.env.API_URL}/v1/auth/github/login`));
    const org = await loadJson(deps.fetch, `${github.GITHUB_API}/orgs/${encodeURIComponent(path)}`, { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "otinstaller-registry" });
    if (!org?.id) apiError(404, "host_not_found", `GitHub has no organization called ${path}`);
    if ((await github.orgRole(deps.fetch, token, org.login)) !== "admin") apiError(403, "host_not_owned", `you are not an owner of the GitHub organization ${org.login}`, "ask an org owner to link it");
    return { ownerId: String(org.id), login: org.login as string, kind: "org" as const };
  }
  const token = await gitlabToken(c.env, userId).catch(() => apiError(400, "host_account_not_linked", "link your GitLab account again", `sign in with GitLab: ${c.env.API_URL}/v1/auth/gitlab/login`));
  const auth = { Authorization: `Bearer ${token}` };
  const group = await loadJson(deps.fetch, `${GITLAB}/api/v4/groups/${encodeURIComponent(path)}?with_projects=false`, auth);
  if (!group?.id) apiError(404, "host_not_found", `GitLab has no group called ${path} that you can see`);
  if (group.visibility !== "public") apiError(400, "invalid_body", "only public GitLab groups can be shown on a profile");
  const member = await loadJson(deps.fetch, `${GITLAB}/api/v4/groups/${group.id}/members/all/${encodeURIComponent(acct.provider_user_id)}`, auth);
  if ((member?.access_level ?? 0) < OWNER) apiError(403, "host_not_owned", `you are not an Owner of the GitLab group ${group.full_path}`, "ask a group Owner to link it");
  return { ownerId: String(group.id), login: group.full_path as string, kind: "group" as const };
}

export function profileRoutes(app: App) {
  // ---------- public ----------

  // Publishers with at least one visible package, most installed first (for the site's sitemap and llms.txt).
  app.get("/namespaces", async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT n.name, n.kind, n.verified, n.display_name, p.host_name, p.custom_json, COUNT(*) AS packages, SUM(t.installs_30d) AS installs_30d
       FROM tools t JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN namespace_profiles p ON p.namespace_id = n.id
       WHERE ${VISIBLE} AND ${LISTED} GROUP BY n.id ORDER BY installs_30d DESC, n.name LIMIT 500`,
    ).all<{ name: string; kind: string; verified: number; display_name: string | null; host_name: string | null; custom_json: string | null; packages: number; installs_30d: number }>();
    cached(c, 600);
    return c.json({
      namespaces: rows.results.map((r) => {
        const custom = JSON.parse(r.custom_json ?? "{}") as { display_name?: string };
        return { name: r.name, kind: r.kind, verified: r.verified === 1, display_name: custom.display_name || r.host_name || r.display_name || r.name, packages: r.packages, installs_30d: r.installs_30d ?? 0 };
      }),
    });
  });

  app.get("/namespaces/:ns", async (c) => {
    const name = c.req.param("ns");
    const ns = await namespaceByName(c.env, name);
    if (!ns || !PUBLIC_STATUSES.includes(ns.status)) apiError(404, "namespace_not_found", `${name} is not a registry namespace`);
    const [p, hosts] = await Promise.all([profileOf(c.env, ns.id), hostsOf(c.env, ns.id)]);
    const base = { name: ns.name, kind: ns.kind, provider: ns.provider, status: ns.status, created_at: ns.created_at };
    if (ns.status !== "active") {
      // Waiting for review: nothing the owner wrote and no packages, only who it is on the host.
      cached(c, 300);
      return c.json({
        ...base, display_name: ns.name, avatar_url: null, verified: false, tools: [],
        profile: { hosts: publicHosts(ns, p, hosts), bio: null, location: null, website: null, company: null, socials: [], members: [], about_html: null, pins: [], details_hidden: false, host_since: null },
        stats: { packages: 0, tools: 0, guides: 0, installs_30d: 0, installs_total: 0, stars: 0, healthy: 0, broken: 0, last_published_at: null },
      });
    }
    const [tools, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${SUMMARY_COLUMNS}, v.published_at FROM tools t JOIN namespaces n ON n.id = t.namespace_id
         JOIN versions v ON v.id = t.latest_version_id WHERE n.id = ? AND ${VISIBLE} ORDER BY t.installs_30d DESC, t.name`,
      ).bind(ns.id).all<SummaryRow & { published_at: number | null }>(),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(ic.count), 0) AS n FROM install_counts ic JOIN tools t ON t.id = ic.tool_id
         WHERE t.namespace_id = ? AND t.status != 'removed' AND t.latest_version_id IS NOT NULL`,
      ).bind(ns.id).first<{ n: number }>(),
    ]);
    const list = tools.results.map((r) => ({ ...summary(r), published_at: r.published_at }));
    const prof = effectiveProfile(ns, p, hosts);
    const visible = new Set(list.map((t) => t.name));
    const onlyTools = list.filter((t) => t.kind === "tool");
    cached(c, 300);
    return c.json({
      ...base,
      display_name: prof.display_name,
      avatar_url: prof.avatar_url,
      verified: ns.verified === 1,
      profile: {
        bio: prof.bio, location: prof.location, website: prof.website, company: prof.company, socials: prof.socials, members: prof.members,
        hosts: prof.hosts, about_html: prof.about_html, pins: prof.pins.filter((n) => visible.has(n)).slice(0, MAX_PINS),
        details_hidden: prof.details_hidden, host_since: prof.host_since,
      },
      stats: {
        packages: list.length,
        tools: onlyTools.length,
        guides: list.length - onlyTools.length,
        installs_30d: list.reduce((s, t) => s + t.installs_30d, 0),
        installs_total: total?.n ?? 0,
        stars: list.reduce((s, t) => s + t.stars, 0),
        healthy: onlyTools.filter((t) => t.health === "healthy").length,
        broken: onlyTools.filter((t) => t.health === "broken").length,
        last_published_at: list.reduce<number | null>((m, t) => (t.published_at && (!m || t.published_at > m) ? t.published_at : m), null),
      },
      tools: list,
    });
  });

  // Public events from the audit log: releases, yanks, deprecations and transfers of visible packages.
  app.get("/namespaces/:ns/activity", async (c) => {
    const name = c.req.param("ns");
    const ns = await namespaceByName(c.env, name);
    if (!ns || !PUBLIC_STATUSES.includes(ns.status)) apiError(404, "namespace_not_found", `${name} is not a registry namespace`);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30) || 30, 1), 100);
    const rows = ns.status !== "active" ? [] : (await c.env.DB.prepare(
      `SELECT a.action AS action, a.created_at AS created_at, t.name AS name, t.kind AS kind, v.version AS version, NULL AS meta FROM tools t JOIN versions v ON v.tool_id = t.id
         JOIN audit_log a ON a.target_id = v.id AND a.target_kind = 'version'
       WHERE t.namespace_id = ?1 AND t.status != 'removed' AND t.latest_version_id IS NOT NULL AND v.status != 'removed'
         AND a.action IN ('version.published', 'version.yank', 'version.unyank')
       UNION ALL
       SELECT a.action, a.created_at, t.name, t.kind, NULL, a.metadata_json FROM tools t JOIN audit_log a ON a.target_id = t.id AND a.target_kind = 'tool'
       WHERE t.namespace_id = ?1 AND t.status != 'removed' AND t.latest_version_id IS NOT NULL
         AND a.action IN ('tool.deprecate', 'tool.undeprecate', 'transfer.complete')
       ORDER BY created_at DESC LIMIT ?2`,
    ).bind(ns.id, limit).all<{ action: string; created_at: number; name: string; kind: string; version: string | null; meta: string | null }>()).results;
    cached(c, 300);
    return c.json({
      namespace: ns.name,
      events: rows.map((r) => {
        const meta = r.action === "transfer.complete" ? (JSON.parse(r.meta ?? "{}") as { from?: string; to?: string }) : {};
        return {
          type: ACTIVITY[r.action] ?? r.action, ref: `${ns.name}/${r.name}`, kind: r.kind, at: r.created_at,
          ...(r.version ? { version: r.version } : {}), ...(meta.from ? { from: meta.from, to: meta.to } : {}),
        };
      }),
    });
  });

  // ---------- owners ----------

  app.get("/me/namespaces/:ns/profile", async (c) => {
    const { ns, userId } = await ownedNamespace(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownerView(c, ns, userId));
  });

  app.patch("/me/namespaces/:ns/profile", async (c) => {
    const { ns, userId } = await ownedNamespace(c);
    const body = await c.req.json<{ custom?: Record<string, unknown>; about?: string | null; pins?: unknown; hide_details?: unknown }>().catch(() => ({}) as Record<string, never>);
    if (!body || typeof body !== "object" || Array.isArray(body)) apiError(400, "invalid_body", "send {custom, about, pins, hide_details}");
    const db = c.env.DB;
    const now = Date.now();
    await db.prepare(`INSERT INTO namespace_profiles (namespace_id, updated_at) VALUES (?, ?) ON CONFLICT (namespace_id) DO NOTHING`).bind(ns.id, now).run();
    const p = (await profileOf(c.env, ns.id))!;
    const sets: string[] = [];
    const binds: unknown[] = [];
    const changed: string[] = [];
    if (body.custom !== undefined) {
      if (!body.custom || typeof body.custom !== "object" || Array.isArray(body.custom)) apiError(400, "invalid_body", "custom is an object of field: value (null uses the host value)");
      const custom = JSON.parse(p.custom_json) as Record<string, unknown>;
      for (const [field, value] of Object.entries(body.custom)) {
        const v = overrideValue(field, value);
        if (v === null) delete custom[field];
        else custom[field] = v;
        changed.push(field);
      }
      sets.push("custom_json = ?");
      binds.push(JSON.stringify(custom));
    }
    if (body.about !== undefined) {
      if (body.about !== null && typeof body.about !== "string") apiError(400, "invalid_body", "about is Markdown text, or null to remove it");
      const md = body.about?.trim() ? body.about : null;
      if (md && md.length > MAX_ABOUT) apiError(400, "invalid_body", `about is at most ${MAX_ABOUT} characters`);
      sets.push("about_md = ?", "about_html = ?");
      binds.push(md, md ? renderAbout(c.env, ns.name, md).html : null);
      changed.push("about");
    }
    if (body.pins !== undefined) {
      if (!Array.isArray(body.pins) || body.pins.some((x) => typeof x !== "string")) apiError(400, "invalid_body", "pins is a list of package names");
      const pins = [...new Set(body.pins as string[])];
      if (pins.length > MAX_PINS) apiError(400, "invalid_body", `pin at most ${MAX_PINS} packages`);
      const known = new Set((await db.prepare(`SELECT name FROM tools WHERE namespace_id = ? AND status != 'removed'`).bind(ns.id).all<{ name: string }>()).results.map((r) => r.name));
      const unknown = pins.filter((x) => !known.has(x));
      if (unknown.length) apiError(400, "invalid_body", `not packages in ${ns.name}: ${unknown.join(", ")}`);
      sets.push("pins_json = ?");
      binds.push(JSON.stringify(pins));
      changed.push("pins");
    }
    if (body.hide_details !== undefined) {
      if (typeof body.hide_details !== "boolean") apiError(400, "invalid_body", "hide_details is true or false");
      sets.push("hide_details = ?");
      binds.push(body.hide_details ? 1 : 0);
      changed.push("hide_details");
    }
    if (!sets.length) apiError(400, "invalid_body", "send at least one of custom, about, pins, hide_details");
    await db.batch([
      db.prepare(`UPDATE namespace_profiles SET ${sets.join(", ")}, updated_at = ? WHERE namespace_id = ?`).bind(...binds, now, ns.id),
      audit(db, userId, "user", "profile.update", "namespace", ns.id, { fields: changed }),
    ]);
    if (changed.includes("avatar_url")) {
      const custom = JSON.parse(((await profileOf(c.env, ns.id))!).custom_json) as Record<string, unknown>;
      await db.prepare(`UPDATE namespaces SET avatar_url = ? WHERE id = ?`).bind((custom.avatar_url as string) || p.host_avatar_url, ns.id).run();
    }
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownerView(c, ns, userId));
  });

  app.post("/me/namespaces/:ns/profile/preview", async (c) => {
    const { ns } = await ownedNamespace(c);
    const { about } = await c.req.json<{ about?: string }>().catch(() => ({}) as { about?: string });
    if (typeof about !== "string") apiError(400, "invalid_body", "send {about: '# Markdown'}");
    if (about.length > MAX_ABOUT) apiError(400, "invalid_body", `about is at most ${MAX_ABOUT} characters`);
    c.header("Cache-Control", "private, no-store");
    return c.json(renderAbout(c.env, ns.name, about));
  });

  app.post("/me/namespaces/:ns/profile/sync", async (c) => {
    const { ns, userId } = await ownedNamespace(c);
    if (await overLimit(c.env, "profile_sync", ns.id, MANUAL_PROFILE_SYNCS_PER_HOUR, 3600_000)) {
      rateLimited("profile_sync_rate_limited", `at most ${MANUAL_PROFILE_SYNCS_PER_HOUR} profile syncs an hour`, "the registry also refreshes profiles every 6 hours",
        windowRetry(3600_000), MANUAL_PROFILE_SYNCS_PER_HOUR, 3600);
    }
    const r = await syncProfile(c.env, ns.id, userId);
    await audit(c.env.DB, userId, "user", "profile.sync", "namespace", ns.id, { status: r.status }).run();
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownerView(c, ns, userId));
  });

  app.post("/me/namespaces/:ns/profile/hosts", async (c) => {
    const { ns, userId } = await ownedNamespace(c);
    const { provider, account } = await c.req.json<{ provider?: string; account?: string }>().catch(() => ({}) as { provider?: string; account?: string });
    if (provider !== "github" && provider !== "gitlab") apiError(400, "invalid_body", "send {provider: 'github' | 'gitlab', account?: 'org-or-group'}");
    if (ns.provider === provider) apiError(409, "host_already_primary", `${ns.name} is already bound to ${provider === "github" ? "GitHub" : "GitLab"}`, "link the other host instead");
    const a = await secondaryAccount(c, userId, provider, account?.trim() || undefined);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO namespace_hosts (namespace_id, provider, provider_owner_id, login, kind, linked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (namespace_id, provider) DO UPDATE SET provider_owner_id = excluded.provider_owner_id, login = excluded.login, kind = excluded.kind,
           linked_by = excluded.linked_by, created_at = excluded.created_at`,
      ).bind(ns.id, provider, a.ownerId, a.login, a.kind, userId, Date.now()),
      audit(c.env.DB, userId, "user", "profile.host_link", "namespace", ns.id, { provider, login: a.login }),
    ]);
    await syncProfile(c.env, ns.id, userId);
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownerView(c, ns, userId), 201);
  });

  app.delete("/me/namespaces/:ns/profile/hosts/:provider", async (c) => {
    const { ns, userId } = await ownedNamespace(c);
    const provider = c.req.param("provider");
    const r = await c.env.DB.prepare(`DELETE FROM namespace_hosts WHERE namespace_id = ? AND provider = ?`).bind(ns.id, provider).run();
    if (!r.meta.changes) apiError(404, "host_not_found", `${ns.name} has no linked ${provider} account`);
    await audit(c.env.DB, userId, "user", "profile.host_unlink", "namespace", ns.id, { provider }).run();
    await syncProfile(c.env, ns.id, userId);
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownerView(c, ns, userId));
  });
}
