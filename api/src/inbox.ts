// Notifications for people who take part in the community: inbox items written with each event (new issues on a
// package you maintain, replies and status changes on threads you follow, new versions of packages you follow,
// moderation of your posts, roles), and their delivery by email, at once (grouped every 15 minutes) or as a daily
// digest, with one-click unsubscribe.
// Routes live in routes/inbox.ts; publisher and staff emails stay in notify.ts.
import type { Env } from "./env";
import { hmacSha256Hex, safeEqual, ulid } from "./lib/crypto";
import { sendEmail } from "./notify";

export type Scope = "community" | "owner_issues" | "releases" | "account";
export type Pref = "immediate" | "daily" | "off";

/** The issues a new version is announced on (columns of `issues i`): open, visible broken and outdated issues people filed. */
export const ANNOUNCED_ISSUES = `i.kind IN ('broken', 'outdated') AND i.status IN ('open', 'confirmed') AND i.moderation = 'visible' AND i.deleted_at IS NULL AND i.author_kind = 'user'`;

export const PREFS: Pref[] = ["immediate", "daily", "off"];
export const PREF_SCOPES = ["community", "owner_issues", "releases"] as const;

/** Most emails one person gets in a day; more items wait for the next day's digest. */
const PER_USER_DAILY = 12;
/** Items newer than this wait for the next run, so a busy thread becomes one email. */
const SETTLE = 2 * 60_000;

export interface Item {
  kind: "issue_opened" | "comment" | "status" | "moderation" | "role" | "proposal" | "release";
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

/**
 * A new version of a package: one inbox item for each of its followers, written by a single statement however many
 * there are. People who follow one of the package's open broken or outdated issues are left out: they hear about the
 * version on that issue (announceVersion), so nobody gets two items for one release.
 */
export async function notifyFollowers(env: Env, toolId: string, item: Omit<Item, "scope" | "tool_id">, now = Date.now()) {
  await env.DB.prepare(
    `INSERT INTO inbox (id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at)
     SELECT ? || upper(hex(randomblob(8))), f.user_id, ?, 'releases', f.tool_id, NULL, NULL, ?, ?, ?
     FROM package_follows f JOIN users u ON u.id = f.user_id
     WHERE f.tool_id = ? AND u.banned_at IS NULL AND f.user_id NOT IN (
       SELECT s.user_id FROM issue_subscriptions s JOIN issues i ON i.id = s.issue_id WHERE i.tool_id = ? AND s.muted = 0 AND ${ANNOUNCED_ISSUES})`,
  ).bind(ulid(now).slice(0, 10), item.kind, item.summary.slice(0, 300), item.path, now, toolId, toolId).run()
    .catch((e) => console.error("writing release notifications failed", e));
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
         WHEN 'releases' THEN COALESCE(p.releases, 'immediate') ELSE COALESCE(p.owner_issues, 'immediate') END AS pref,
       COALESCE(u.email, (SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.email IS NOT NULL LIMIT 1)) AS email
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
    const scope = (["community", "releases", "owner_issues"] as const).find((s) => items.some((i) => i.scope === s)) ?? "community";
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
  const more = items.length > 25 ? `\n…and ${items.length - 25} more at ${env.SITE_URL}/settings/notifications` : "";
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
