// Notifications for people who take part in the community: inbox items written with each event (new issues on a
// package you maintain, replies and status changes on threads you follow, new versions of packages you follow, their
// lifecycle changes and security warnings, moderation of your posts, roles), and their delivery by email, at once
// (grouped every 15 minutes) or as a daily digest, with one-click unsubscribe. Each person chooses, per kind, whether
// items show in their inbox and how often they are emailed, and which of their sign-in accounts' addresses gets them.
// Routes live in routes/inbox.ts; publisher and staff emails stay in notify.ts.
import type { Env } from "./env";
import { apiError } from "./lib/errors";
import { hmacSha256Hex, safeEqual, ulid } from "./lib/crypto";
import { sendEmail } from "./notify";

export type Scope = "community" | "owner_issues" | "releases" | "lifecycle" | "security" | "account";
export type Pref = "immediate" | "daily" | "off";

/** The issues a new version is announced on (columns of `issues i`): open, visible broken and outdated issues people filed. */
export const ANNOUNCED_ISSUES = `i.kind IN ('broken', 'outdated') AND i.status IN ('open', 'confirmed') AND i.moderation = 'visible' AND i.deleted_at IS NULL AND i.author_kind = 'user'`;

export const PREFS: Pref[] = ["immediate", "daily", "off"];
/** The kinds a person chooses settings for; account items (moderation, roles) always show and are always emailed. */
export const PREF_SCOPES = ["community", "owner_issues", "releases", "lifecycle", "security"] as const;
export type PrefScope = (typeof PREF_SCOPES)[number];

/** How much of a followed package reaches the person (package_follows.level). */
export const FOLLOW_LEVELS = ["all", "releases", "muted"] as const;
export type FollowLevel = (typeof FOLLOW_LEVELS)[number];

/** Most emails one person gets in a day; more items wait for the next day's digest. */
const PER_USER_DAILY = 12;
/** Items newer than this wait for the next run, so a busy thread becomes one email. */
const SETTLE = 2 * 60_000;

export interface Item {
  kind: "issue_opened" | "comment" | "status" | "moderation" | "role" | "proposal" | "release" | "lifecycle" | "security";
  scope: Scope;
  summary: string;
  path: string;
  tool_id?: string | null;
  issue_id?: string | null;
  actor_id?: string | null;
}

/** Statements that put one item in each person's inbox (never the person who acted). */
export function inboxRows(db: D1Database, userIds: string[], item: Item, now = Date.now()): D1PreparedStatement[] {
  return [...new Set(userIds)].filter((u) => u && u !== item.actor_id).map((u) =>
    db.prepare(`INSERT INTO inbox (id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ulid(now), u, item.kind, item.scope, item.tool_id ?? null, item.issue_id ?? null, item.actor_id ?? null, item.summary.slice(0, 300), item.path, now));
}

/** Everyone following a thread, without the muted. */
export async function subscribers(env: Env, issueId: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT user_id FROM issue_subscriptions WHERE issue_id = ? AND muted = 0`).bind(issueId).all<{ user_id: string }>()).results.map((r) => r.user_id);
}

/** Everyone following a tool request (who asked for it, replied or follows it), without the muted. */
export async function requestSubscribers(env: Env, requestId: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT user_id FROM request_subscriptions WHERE request_id = ? AND muted = 0`).bind(requestId).all<{ user_id: string }>()).results.map((r) => r.user_id);
}

/** The members of a package's namespace, and the people who maintain that package (a community package's submitter). */
export async function maintainers(env: Env, namespaceId: string, toolId?: string): Promise<string[]> {
  return (await env.DB.prepare(`SELECT user_id FROM namespace_members WHERE namespace_id = ? UNION SELECT user_id FROM tool_maintainers WHERE tool_id = ?`)
    .bind(namespaceId, toolId ?? "").all<{ user_id: string }>()).results.map((r) => r.user_id);
}

/** A version that just became its package's latest, as notifyFollowers words it. */
export interface Release {
  toolId: string;
  /** namespace/name */
  ref: string;
  namespace: string;
  version: string;
  kind: "tool" | "guide";
  /** The package's first published version: input-type followers hear about new packages only. */
  first: boolean;
  path: string;
}

/**
 * A version became its package's latest: one inbox item for each person who follows the package, its publisher, or
 * (for a new package) one of the input types it takes, written by a single statement however many there are. Each
 * person gets one item, worded for the closest thing they follow. People who follow one of the package's open broken
 * or outdated issues are left out: they hear about the version on that issue (announceVersion). So are people who
 * muted the package, whatever else they follow.
 */
export async function notifyFollowers(env: Env, r: Release, now = Date.now()) {
  const what = r.kind === "guide" ? "guide" : "tool";
  await env.DB.prepare(
    `INSERT INTO inbox (id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at)
     SELECT ?1 || upper(hex(randomblob(8))), c.user_id, 'release', 'releases', ?2, NULL, NULL,
       substr(CASE c.why WHEN 0 THEN ?3 WHEN 1 THEN ?4 ELSE 'New ' || ?5 || ' for ' || replace(c.input, '_', ' ') || ': ' || ?6 END, 1, 300), ?7, ?10
     FROM (
       SELECT user_id, MIN(why) AS why, MIN(input) AS input FROM (
         SELECT user_id, 0 AS why, NULL AS input FROM package_follows WHERE tool_id = ?2 AND level != 'muted'
         UNION ALL SELECT user_id, 1, NULL FROM follows WHERE kind = 'publisher' AND target = ?8
         UNION ALL SELECT user_id, 2, target FROM follows
           WHERE kind = 'input' AND ?9 = 1 AND target IN (SELECT type FROM tool_io WHERE tool_id = ?2 AND direction = 'in')
       ) GROUP BY user_id
     ) c JOIN users u ON u.id = c.user_id
     WHERE u.banned_at IS NULL
       AND c.user_id NOT IN (SELECT user_id FROM package_follows WHERE tool_id = ?2 AND level = 'muted')
       AND c.user_id NOT IN (
         SELECT s.user_id FROM issue_subscriptions s JOIN issues i ON i.id = s.issue_id WHERE i.tool_id = ?2 AND s.muted = 0 AND ${ANNOUNCED_ISSUES})`,
  ).bind(
    ulid(now).slice(0, 10), r.toolId,
    `${r.ref} ${r.version} is out`,
    r.first ? `${r.namespace} published a new ${what}: ${r.ref}` : `${r.ref} ${r.version} is out`,
    what, r.ref, r.path, r.namespace, r.first ? 1 : 0, now,
  ).run().catch((e) => console.error("writing release notifications failed", e));
}

/** Which follow levels hear about lifecycle changes, and which about security warnings (malware takedowns included). */
export const LIFECYCLE_LEVELS: FollowLevel[] = ["all"];
export const SECURITY_LEVELS: FollowLevel[] = ["all", "releases"];

/**
 * Something happened to a followed package (yanked, deprecated, taken down, moved, a security warning): one inbox item
 * for each person following it at one of `levels`, written by a single statement, never for the person who acted.
 * Failures are logged, never thrown, so the action itself never fails over a notification.
 */
export async function notifyPackageFollowers(env: Env, toolId: string, item: Item & { kind: "lifecycle" | "security" }, levels: FollowLevel[], now = Date.now()) {
  if (!levels.length) return;
  await env.DB.prepare(
    `INSERT INTO inbox (id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at)
     SELECT ?1 || upper(hex(randomblob(8))), f.user_id, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8
     FROM package_follows f JOIN users u ON u.id = f.user_id
     WHERE f.tool_id = ?4 AND f.level IN (${levels.map((_, i) => `?${i + 9}`).join(", ")}) AND u.banned_at IS NULL AND f.user_id IS NOT ?5`,
  ).bind(ulid(now).slice(0, 10), item.kind, item.scope, toolId, item.actor_id ?? null, item.summary.slice(0, 300), item.path, now, ...levels)
    .run().catch((e) => console.error(`writing ${item.kind} notifications failed`, e));
}

/** Writes items now; failures are logged, never thrown, so taking part never fails over a notification. */
export async function notify(env: Env, userIds: string[], item: Item) {
  const rows = inboxRows(env.DB, userIds, item);
  if (rows.length) await env.DB.batch(rows).catch((e) => console.error("writing inbox items failed", e));
}

// ---------- unsubscribe links ----------

/** The signature on an unsubscribe link for one person and one preference. */
export async function unsubscribeToken(env: Env, userId: string, scope: string): Promise<string> {
  return (await hmacSha256Hex(env.TOKEN_ENC_KEY ?? "ot-unsubscribe", `unsubscribe|${userId}|${scope}`)).slice(0, 32);
}

export async function unsubscribeUrl(env: Env, userId: string, scope: string): Promise<string> {
  const q = new URLSearchParams({ u: userId, s: scope, t: await unsubscribeToken(env, userId, scope) });
  return `${env.API_URL}/v1/unsubscribe?${q}`;
}

/** Turns one preference off when the link's signature matches. */
export async function unsubscribe(env: Env, userId: string, scope: string, token: string): Promise<boolean> {
  if (!(PREF_SCOPES as readonly string[]).includes(scope)) return false;
  if (!safeEqual(token, await unsubscribeToken(env, userId, scope))) return false;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO email_prefs (user_id, ${scope}, updated_at) VALUES (?, 'off', ?) ON CONFLICT (user_id) DO UPDATE SET ${scope} = 'off', updated_at = excluded.updated_at`,
  ).bind(userId, now).run();
  return true;
}

// ---------- settings ----------

type PrefsRow = Record<PrefScope, Pref> & { inbox_muted_json: string; email_provider: string | null };

/** What a person chose: per kind, whether items show in the inbox and how often they are emailed, and where emails go. */
export interface NotificationSettings {
  scopes: Record<PrefScope, { inbox: boolean; email: Pref }>;
  email: { to: string | null; address: string | null; options: { provider: string; address: string }[] };
}

async function prefsRow(env: Env, userId: string): Promise<PrefsRow | null> {
  return env.DB.prepare(`SELECT community, owner_issues, releases, lifecycle, security, inbox_muted_json, email_provider FROM email_prefs WHERE user_id = ?`)
    .bind(userId).first<PrefsRow>();
}

function mutedOf(row: PrefsRow | null): PrefScope[] {
  try {
    const list = JSON.parse(row?.inbox_muted_json ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((s): s is PrefScope => (PREF_SCOPES as readonly string[]).includes(s)) : [];
  } catch {
    return [];
  }
}

/** Each kind's email preference (immediate when never set). */
export async function emailPrefs(env: Env, userId: string): Promise<Record<PrefScope, Pref>> {
  const row = await prefsRow(env, userId);
  return Object.fromEntries(PREF_SCOPES.map((s) => [s, row?.[s] ?? "immediate"])) as Record<PrefScope, Pref>;
}

/** The kinds whose items stay out of the person's inbox list (and its unread count). */
export async function hiddenScopes(env: Env, userId: string): Promise<PrefScope[]> {
  return mutedOf(await prefsRow(env, userId));
}

/** A condition on inbox.scope that leaves the hidden kinds out, with its bindings. */
export function visibleScopeSql(hidden: string[]): { sql: string; binds: string[] } {
  return hidden.length ? { sql: `scope NOT IN (${hidden.map(() => "?").join(", ")})`, binds: hidden } : { sql: "1 = 1", binds: [] };
}

export async function notificationSettings(env: Env, userId: string): Promise<NotificationSettings> {
  const [row, accounts, user] = await Promise.all([
    prefsRow(env, userId),
    env.DB.prepare(`SELECT provider, email FROM accounts WHERE user_id = ? AND email IS NOT NULL ORDER BY provider`).bind(userId).all<{ provider: string; email: string }>(),
    env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string | null }>(),
  ]);
  const muted = mutedOf(row);
  const options = accounts.results.map((a) => ({ provider: a.provider, address: a.email }));
  const chosen = options.find((o) => o.provider === row?.email_provider);
  return {
    scopes: Object.fromEntries(PREF_SCOPES.map((s) => [s, { inbox: !muted.includes(s), email: row?.[s] ?? "immediate" }])) as NotificationSettings["scopes"],
    // The same address deliverInbox picks.
    email: { to: chosen?.provider ?? null, address: chosen?.address ?? user?.email ?? options[0]?.address ?? null, options },
  };
}

/**
 * Saves part of a person's settings: `{scopes: {releases: {inbox, email}, ...}, email_to}`. Anything left out keeps
 * its value; `email_to: null` goes back to the first address known.
 */
export async function saveNotificationSettings(env: Env, userId: string, body: Record<string, unknown>): Promise<NotificationSettings> {
  const bad = (message: string): never => apiError(400, "invalid_body", message);
  const row = await prefsRow(env, userId);
  const email = Object.fromEntries(PREF_SCOPES.map((s) => [s, row?.[s] ?? "immediate"])) as Record<PrefScope, Pref>;
  const muted = new Set(mutedOf(row));
  if (body.scopes !== undefined) {
    if (!body.scopes || typeof body.scopes !== "object" || Array.isArray(body.scopes)) bad("scopes is an object such as {\"releases\": {\"inbox\": true, \"email\": \"daily\"}}");
    for (const [k, v] of Object.entries(body.scopes as Record<string, unknown>)) {
      if (!(PREF_SCOPES as readonly string[]).includes(k)) bad(`unknown kind ${k}; kinds are ${PREF_SCOPES.join(", ")}`);
      const s = k as PrefScope;
      const set = (v ?? {}) as { inbox?: unknown; email?: unknown };
      if (typeof set !== "object") bad(`${k} is an object with inbox and email`);
      if (set.inbox !== undefined) {
        if (typeof set.inbox !== "boolean") bad(`${k}.inbox is true or false`);
        if (set.inbox) muted.delete(s);
        else muted.add(s);
      }
      if (set.email !== undefined) {
        if (!PREFS.includes(set.email as Pref)) bad(`${k}.email must be one of: ${PREFS.join(", ")}`);
        email[s] = set.email as Pref;
      }
    }
  }
  let provider = row?.email_provider ?? null;
  if (body.email_to !== undefined) {
    if (body.email_to === null) provider = null;
    else {
      const has = typeof body.email_to === "string" && await env.DB.prepare(`SELECT 1 FROM accounts WHERE user_id = ? AND provider = ? AND email IS NOT NULL`).bind(userId, body.email_to).first();
      if (!has) bad(`email_to names one of your sign-in accounts that has an email address (github, gitlab or osintverse)`);
      provider = body.email_to as string;
    }
  }
  await savePrefs(env, userId, email, [...muted], provider);
  return notificationSettings(env, userId);
}

/** Writes the whole preferences row. */
export async function savePrefs(env: Env, userId: string, email: Record<PrefScope, Pref>, muted: PrefScope[], provider: string | null) {
  await env.DB.prepare(
    `INSERT INTO email_prefs (user_id, community, owner_issues, releases, lifecycle, security, inbox_muted_json, email_provider, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET community = excluded.community, owner_issues = excluded.owner_issues, releases = excluded.releases,
       lifecycle = excluded.lifecycle, security = excluded.security, inbox_muted_json = excluded.inbox_muted_json,
       email_provider = excluded.email_provider, updated_at = excluded.updated_at`,
  ).bind(userId, email.community, email.owner_issues, email.releases, email.lifecycle, email.security, JSON.stringify(PREF_SCOPES.filter((s) => muted.includes(s))), provider, Date.now()).run();
}

/** Changes some email preferences and keeps the rest (PUT /me/email-prefs, the older form of the settings). */
export async function saveEmailPrefs(env: Env, userId: string, b: Record<string, unknown>): Promise<Record<PrefScope, Pref>> {
  for (const k of PREF_SCOPES) {
    if (b[k] !== undefined && !PREFS.includes(b[k] as Pref)) apiError(400, "invalid_body", `${k} must be one of: ${PREFS.join(", ")}`);
  }
  const row = await prefsRow(env, userId);
  const next = Object.fromEntries(PREF_SCOPES.map((s) => [s, (b[s] as Pref | undefined) ?? row?.[s] ?? "immediate"])) as Record<PrefScope, Pref>;
  await savePrefs(env, userId, next, mutedOf(row), row?.email_provider ?? null);
  return next;
}

// ---------- delivery ----------

type Pending = { id: string; user_id: string; kind: string; scope: Scope; summary: string; path: string; created_at: number; pref: Pref; email: string | null };

/**
 * Emails what is waiting. `immediate` (every 15 minutes) sends items whose preference is immediate, plus account items;
 * `daily` (nightly) sends the daily digests. Items whose preference is off are marked and never sent. An item is only
 * marked emailed once the send succeeded (or was skipped because email is not set up), so a failed send is retried.
 */
export async function deliverInbox(env: Env, mode: "immediate" | "daily", now = Date.now()) {
  const db = env.DB;
  const rows = (await db.prepare(
    `SELECT i.id, i.user_id, i.kind, i.scope, i.summary, i.path, i.created_at,
       CASE i.scope WHEN 'account' THEN 'immediate' WHEN 'community' THEN COALESCE(p.community, 'immediate')
         WHEN 'releases' THEN COALESCE(p.releases, 'immediate') WHEN 'lifecycle' THEN COALESCE(p.lifecycle, 'immediate')
         WHEN 'security' THEN COALESCE(p.security, 'immediate') ELSE COALESCE(p.owner_issues, 'immediate') END AS pref,
       -- The address the person chose from their sign-in accounts, else the first one known.
       COALESCE((SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.provider = p.email_provider AND a.email IS NOT NULL), u.email,
         (SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.email IS NOT NULL ORDER BY a.provider LIMIT 1)) AS email
     FROM inbox i JOIN users u ON u.id = i.user_id LEFT JOIN email_prefs p ON p.user_id = i.user_id
     WHERE i.emailed_at IS NULL AND i.created_at <= ? AND i.created_at > ? AND u.banned_at IS NULL
     ORDER BY i.user_id, i.created_at LIMIT 2000`,
  ).bind(now - SETTLE, now - 7 * 86_400_000).all<Pending>()).results;
  // Nothing to send to: the preference is off, or the person has no email address.
  const off = rows.filter((r) => r.pref === "off" || !r.email);
  const due = rows.filter((r) => r.email && (r.pref === mode || (mode === "daily" && r.pref === "immediate")));
  if (off.length) await db.batch(off.map((r) => db.prepare(`UPDATE inbox SET emailed_at = ? WHERE id = ?`).bind(now, r.id)));
  const byUser = new Map<string, Pending[]>();
  for (const r of due) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  let sent = 0;
  for (const [userId, items] of byUser) {
    const today = (await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'community' AND to_email = ? AND created_at > ?`)
      .bind(items[0]!.email, now - 86_400_000).first<{ n: number }>())?.n ?? 0;
    if (today >= PER_USER_DAILY && mode === "immediate") continue;
    // The unsubscribe link turns off the first of these the email carries.
    const scope = (["community", "releases", "lifecycle", "security", "owner_issues"] as const).find((s) => items.some((i) => i.scope === s)) ?? "community";
    const result = await sendEmail(env, await composeEmail(env, userId, items, scope, mode));
    if (result === "failed") continue;
    await db.batch(items.map((i) => db.prepare(`UPDATE inbox SET emailed_at = ? WHERE id = ?`).bind(now, i.id)));
    sent++;
  }
  return sent;
}

async function composeEmail(env: Env, userId: string, items: Pending[], scope: string, mode: string) {
  const unsub = await unsubscribeUrl(env, userId, scope);
  const lines = items.slice(0, 25).map((i) => `- ${i.summary}\n  ${env.SITE_URL}${i.path}`);
  const more = items.length > 25 ? `\n…and ${items.length - 25} more at ${env.SITE_URL}/notifications` : "";
  const subject = items.length === 1 ? items[0]!.summary : `${items.length} updates on OTInstaller${mode === "daily" ? " today" : ""}`;
  return {
    to: [items[0]!.email!],
    kind: "community",
    key: `inbox:${userId}:${items.at(-1)!.id}`,
    subject: subject.slice(0, 140),
    text: `${lines.join("\n\n")}${more}\n\n--\nWhat you get and how often: ${env.SITE_URL}/settings/notifications\nStop these emails: ${env.SITE_URL}/unsubscribe?${new URL(unsub).searchParams}`,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** Removes read items after 90 days, and every item after a year (nightly). */
export async function purgeInbox(env: Env, now = Date.now()) {
  await env.DB.prepare(`DELETE FROM inbox WHERE (read_at IS NOT NULL AND read_at < ?) OR created_at < ?`).bind(now - 90 * 86_400_000, now - 365 * 86_400_000).run();
}
