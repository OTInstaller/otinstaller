// People's profiles: a person's handle, what they wrote about themselves (a display name, bio, location, website and
// links), roles, the packages they look after, what they did in the community (counts recomputed nightly into
// contributor_stats) and their recent visible issues and requests. Never their email, login provider or namespaces.
// A hidden profile answers 404. People change their handle at most once every 30 days; old handles stay theirs and
// redirect. Routes live in routes/people.ts; the tables are in migrations 0016, 0019 and 0036.
import type { Env, User } from "./env";
import { apiError, rateLimited } from "./lib/errors";
import { audit } from "./routes/auth";
import { communityRoles, dailyLimit, screen } from "./community";
import { text, uniqueSocials, social, webUrl, type Social } from "./hosts/profiles";
import { bumpCacheEpoch } from "./edge-cache";
import { notify } from "./inbox";

/** Links a profile can hold besides its website. */
export const MAX_LINKS = 3;
/** A new handle: the same shape as a namespace name. */
export const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** How long after changing their handle someone can change it again. */
export const HANDLE_COOLDOWN = 30 * 86_400_000;
/** Handles nobody can take, because they would pass for the registry, its staff or its bots. */
export const RESERVED_HANDLES = new Set([
  "admin", "administrator", "staff", "moderator", "mod", "mods", "reviewer", "triager", "support", "security", "abuse", "help", "root",
  "system", "bot", "otinstaller", "osintverse", "ot", "community", "team", "official", "registry", "anonymous", "deleted", "ghost", "me",
]);

type UserRow = User & {
  handle: string; avatar_url: string | null; profile_hidden: number; banned_at: number | null; created_at: number; handle_changed_at: number | null;
  display_name: string | null; bio: string | null; location: string | null; website: string | null; links_json: string;
};

/** What a person wrote on their profile. */
function fieldsOf(u: UserRow) {
  let links: Social[] = [];
  try {
    links = (JSON.parse(u.links_json || "[]") as Social[]).slice(0, MAX_LINKS);
  } catch {
    // A broken value shows no links rather than failing the page.
  }
  return { display_name: u.display_name, bio: u.bio, location: u.location, website: u.website, links };
}

export type ContributorStats = {
  issues_opened: number; issues_confirmed: number; replies: number; confirmations: number; requests_made: number; requests_published: number; issues_triaged: number;
};

const ZERO: ContributorStats = { issues_opened: 0, issues_confirmed: 0, replies: 0, confirmations: 0, requests_made: 0, requests_published: 0, issues_triaged: 0 };

/** Recomputes everyone's counts who took part; runs nightly. Only visible posts count. */
export async function refreshContributorStats(env: Env, now = Date.now()) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO contributor_stats (user_id, issues_opened, issues_confirmed, replies, confirmations, requests_made, requests_published, issues_triaged, updated_at)
     SELECT u.id,
       (SELECT COUNT(*) FROM issues i WHERE i.author_id = u.id AND i.author_kind = 'user' AND i.moderation = 'visible' AND i.deleted_at IS NULL),
       (SELECT COUNT(*) FROM issues i WHERE i.author_id = u.id AND i.author_kind = 'user' AND i.moderation = 'visible' AND i.deleted_at IS NULL
          AND i.kind IN ('broken', 'outdated', 'wrong_info') AND i.status IN ('confirmed', 'fixed')),
       (SELECT COUNT(*) FROM issue_comments c WHERE c.author_id = u.id AND c.author_kind = 'user' AND c.moderation = 'visible' AND c.deleted_at IS NULL)
         + (SELECT COUNT(*) FROM request_comments c WHERE c.author_id = u.id AND c.author_kind = 'user' AND c.moderation = 'visible' AND c.deleted_at IS NULL),
       (SELECT COUNT(*) FROM confirmations f WHERE f.user_id = u.id),
       (SELECT COUNT(*) FROM tool_requests r WHERE r.requested_by = u.id AND r.moderation = 'visible'),
       (SELECT COUNT(*) FROM tool_requests r WHERE r.requested_by = u.id AND r.moderation = 'visible' AND r.status = 'published'),
       (SELECT COUNT(*) FROM issues i WHERE i.closed_by = u.id AND (i.author_id IS NULL OR i.author_id != u.id)),
       ?
     FROM users u WHERE u.id IN (
       SELECT author_id FROM issues UNION SELECT author_id FROM issue_comments UNION SELECT user_id FROM confirmations
       UNION SELECT requested_by FROM tool_requests UNION SELECT closed_by FROM issues)
       -- D1 allows five parts in a compound SELECT.
       OR u.id IN (SELECT author_id FROM request_comments)`,
  ).bind(now).run();
}

/**
 * Someone's public profile, or 404 when there is nobody by that handle, or they hid it or were banned. A handle the
 * person had before answers their profile with `moved_to`, their handle now, so pages can redirect.
 */
export async function profile(env: Env, handle: string) {
  const h = handle.toLowerCase();
  let u = await env.DB.prepare(`SELECT * FROM users WHERE handle = ?`).bind(h).first<UserRow>();
  let movedTo: string | null = null;
  if (!u) {
    u = await env.DB.prepare(`SELECT u.* FROM handle_aliases a JOIN users u ON u.id = a.user_id WHERE a.handle = ?`).bind(h).first<UserRow>();
    movedTo = u?.handle ?? null;
  }
  if (!u || u.profile_hidden || u.banned_at) apiError(404, "person_not_found", `nobody called ${handle} has a public profile`);
  const [stats, roles, issues, requests, maintains] = await Promise.all([
    env.DB.prepare(`SELECT * FROM contributor_stats WHERE user_id = ?`).bind(u.id).first<ContributorStats & { updated_at: number }>(),
    communityRoles(env, u),
    env.DB.prepare(
      `SELECT i.number, i.kind, i.status, i.title, i.created_at, n.name AS ns, t.name AS tool FROM issues i JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE i.author_id = ? AND i.author_kind = 'user' AND i.moderation = 'visible' AND i.deleted_at IS NULL AND t.status != 'removed' AND n.status = 'active'
       ORDER BY i.created_at DESC LIMIT 10`,
    ).bind(u.id).all<{ number: number; kind: string; status: string; title: string; created_at: number; ns: string; tool: string }>(),
    env.DB.prepare(
      `SELECT number, repo_path, status, created_at FROM tool_requests WHERE requested_by = ? AND moderation = 'visible' ORDER BY created_at DESC LIMIT 10`,
    ).bind(u.id).all<{ number: number; repo_path: string; status: string; created_at: number }>(),
    // The packages whose page lists them as a maintainer (never the namespaces they belong to, which can be private).
    env.DB.prepare(
      `SELECT n.name || '/' || t.name AS ref, t.kind, t.summary FROM tool_maintainers m JOIN tools t ON t.id = m.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE m.user_id = ? AND n.status = 'active' AND t.status != 'removed' AND t.latest_version_id IS NOT NULL ORDER BY n.name, t.name LIMIT 50`,
    ).bind(u.id).all<{ ref: string; kind: string; summary: string | null }>(),
  ]);
  const counts = stats ? Object.fromEntries(Object.keys(ZERO).map((k) => [k, stats[k as keyof ContributorStats]])) as ContributorStats : ZERO;
  const staff = !!(u.is_admin || u.is_reviewer);
  const badges = [...(staff ? ["staff"] : []), ...[...roles].filter(() => !staff).sort()];
  return {
    handle: u.handle,
    ...(movedTo ? { moved_to: movedTo } : {}),
    avatar_url: u.avatar_url,
    ...fieldsOf(u),
    joined: new Date(u.created_at).toISOString().slice(0, 7),
    roles: badges,
    counts,
    counted_at: stats?.updated_at ?? null,
    maintains: maintains.results,
    issues: issues.results.map((i) => ({ ref: `${i.ns}/${i.tool}`, number: i.number, kind: i.kind, status: i.status, title: i.title, created_at: i.created_at })),
    requests: requests.results.map((r) => ({ number: r.number, repo: r.repo_path, status: r.status, created_at: r.created_at })),
    // Worth a search engine's time once the community has recognised something they did.
    indexable: badges.length > 0 || counts.issues_confirmed > 0 || counts.requests_published > 0 || counts.issues_triaged > 0 || maintains.results.length > 0,
  };
}

// ---------- your own profile ----------

/** The signed-in person's profile as they edit it: what they wrote, their handle and when they can change it. */
export async function ownProfile(env: Env, user: User) {
  const u = (await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first<UserRow>())!;
  return {
    handle: u.handle ?? user.login.toLowerCase(),
    ...fieldsOf(u),
    hidden: !!u.profile_hidden,
    avatar_url: u.avatar_url,
    handle_changed_at: u.handle_changed_at,
    next_handle_change_at: u.handle_changed_at ? u.handle_changed_at + HANDLE_COOLDOWN : null,
  };
}

/**
 * Changes what the person wrote on their profile: `{display_name, bio, location, website, links, hidden}`, each left
 * out kept as it was, an empty value cleared. Text that looks like personal data or a secret is refused: a profile is
 * public, and no place for an address, a phone number or a key.
 */
export async function updateProfile(env: Env, user: User, b: Record<string, unknown>) {
  const bad = (field: string, what: string): never => apiError(400, "invalid_body", `${field} ${what}`);
  const set: Record<string, string | null> = {};
  for (const [field, max] of [["display_name", 100], ["bio", 400], ["location", 100]] as const) {
    if (b[field] === undefined) continue;
    if (b[field] !== null && typeof b[field] !== "string") bad(field, "must be text");
    set[field] = text(b[field], max);
  }
  if (b.website !== undefined) {
    set.website = b.website === null || b.website === "" ? null : webUrl(b.website) ?? bad("website", "must be an http(s) URL");
  }
  if (b.links !== undefined) {
    if (!Array.isArray(b.links) || b.links.length > MAX_LINKS) bad("links", `must be a list of up to ${MAX_LINKS} URLs`);
    const list = (b.links as unknown[]).filter((l) => l !== "").map((l) => social(l) ?? bad("links", `has an entry that is not an http(s) URL: ${String(l).slice(0, 80)}`));
    set.links_json = JSON.stringify(uniqueSocials(list).slice(0, MAX_LINKS));
  }
  if (b.hidden !== undefined && typeof b.hidden !== "boolean") bad("hidden", "is true or false");
  const hits = screen([set.display_name, set.bio, set.location].filter(Boolean).join("\n"));
  if (hits.length) {
    apiError(400, "profile_screened", `your profile can't hold ${hits.map((h) => h.replace(/_/g, " ")).join(", ")}`,
      "profiles are public: leave out email addresses, phone numbers, street addresses, IP addresses and keys, and link your website instead");
  }
  const columns = Object.keys(set);
  if (columns.length) {
    await dailyLimit(env, "profile", user.id, 30);
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...columns.map((c) => set[c]), user.id),
      audit(env.DB, user.id, "user", "profile.update", "user", user.id, { fields: columns.map((c) => c.replace(/_json$/, "")) }),
    ]);
  }
  if (typeof b.hidden === "boolean") await setProfileHidden(env, user, b.hidden);
  return ownProfile(env, user);
}

/**
 * Gives the person a new handle. It has the shape of a namespace name, isn't reserved, isn't anyone else's handle (now
 * or before) and isn't a namespace they don't belong to, so nobody can pass for a publisher. The old handle stays
 * theirs and redirects; they can take it back later. At most once every 30 days.
 */
export async function changeHandle(env: Env, user: User, wanted: unknown, now = Date.now()) {
  const h = typeof wanted === "string" ? wanted.trim().toLowerCase() : "";
  if (!HANDLE.test(h) || RESERVED_HANDLES.has(h)) {
    apiError(400, "invalid_handle", RESERVED_HANDLES.has(h) ? `${h} is reserved` : "a handle is 3 to 40 lowercase letters, digits and hyphens, starting and ending with a letter or digit");
  }
  const me = (await env.DB.prepare(`SELECT handle, handle_changed_at FROM users WHERE id = ?`).bind(user.id).first<{ handle: string | null; handle_changed_at: number | null }>())!;
  if (me.handle === h) return { handle: h, previous: null };
  if (me.handle_changed_at && now - me.handle_changed_at < HANDLE_COOLDOWN) {
    const next = me.handle_changed_at + HANDLE_COOLDOWN;
    rateLimited("handle_change_too_soon", `you changed your handle on ${day(me.handle_changed_at)}; you can change it again on ${day(next)}`, undefined,
      Math.ceil((next - now) / 1000), 1, HANDLE_COOLDOWN / 1000);
  }
  const [other, alias, ns] = await Promise.all([
    env.DB.prepare(`SELECT 1 FROM users WHERE handle = ? AND id != ?`).bind(h, user.id).first(),
    env.DB.prepare(`SELECT 1 FROM handle_aliases WHERE handle = ? AND user_id != ?`).bind(h, user.id).first(),
    env.DB.prepare(`SELECT 1 FROM namespaces n WHERE n.name = ? AND NOT EXISTS (SELECT 1 FROM namespace_members m WHERE m.namespace_id = n.id AND m.user_id = ?)`).bind(h, user.id).first(),
  ]);
  if (other || alias || ns) apiError(409, "handle_taken", `${h} is taken`, ns && !other && !alias ? "it is a publisher's name in the registry; choose another" : "choose another");
  const stmts = [
    env.DB.prepare(`DELETE FROM handle_aliases WHERE handle = ? AND user_id = ?`).bind(h, user.id),
    env.DB.prepare(`UPDATE users SET handle = ?, handle_changed_at = ? WHERE id = ?`).bind(h, now, user.id),
    audit(env.DB, user.id, "user", "profile.handle", "user", user.id, { from: me.handle, to: h }),
  ];
  if (me.handle) stmts.unshift(env.DB.prepare(`INSERT OR REPLACE INTO handle_aliases (handle, user_id, created_at) VALUES (?, ?, ?)`).bind(me.handle, user.id, now));
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    // Someone signed in with that login a moment ago.
    if (String(e).includes("UNIQUE")) apiError(409, "handle_taken", `${h} is taken`, "choose another");
    throw e;
  }
  return { handle: h, previous: me.handle };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A moderator clears what someone wrote on their profile (their handle, avatar and activity stay); they are told. */
export async function clearProfile(env: Env, staff: User, handle: string) {
  const u = await env.DB.prepare(`SELECT id FROM users WHERE handle = ?`).bind(handle.toLowerCase()).first<{ id: string }>();
  if (!u) apiError(404, "person_not_found", `nobody is called ${handle}`);
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET display_name = NULL, bio = NULL, location = NULL, website = NULL, links_json = '[]' WHERE id = ?`).bind(u.id),
    audit(env.DB, staff.id, "user", "profile.clear", "user", u.id, { handle }),
    // Cached copies of the profile go at once.
    bumpCacheEpoch(env.DB),
  ]);
  await notify(env, [u.id], {
    kind: "moderation", scope: "account", actor_id: staff.id, path: "/settings/profile",
    summary: "A moderator cleared what you wrote on your profile; it broke the community rules",
  });
}

/** Hides or shows the person's profile and avatar on their posts. */
export async function setProfileHidden(env: Env, user: User, hidden: boolean) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET profile_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, user.id),
    audit(env.DB, user.id, "user", hidden ? "profile.hide" : "profile.show", "user", user.id),
  ]);
}
