// Contributor profiles: a person's handle, roles, what they did in the community (counts recomputed nightly into
// contributor_stats) and their recent visible issues and requests. Never their email, login provider or namespaces.
// A hidden profile answers 404. Routes live in routes/people.ts; the table is in migration 0019.
import type { Env, User } from "./env";
import { apiError } from "./lib/errors";
import { audit } from "./routes/auth";
import { communityRoles } from "./community";

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

/** Someone's public profile, or 404 when there is nobody by that handle, or they hid it or were banned. */
export async function profile(env: Env, handle: string) {
  const u = await env.DB.prepare(`SELECT * FROM users WHERE handle = ?`).bind(handle.toLowerCase()).first<User & { handle: string; avatar_url: string | null; profile_hidden: number; banned_at: number | null; created_at: number }>();
  if (!u || u.profile_hidden || u.banned_at) apiError(404, "person_not_found", `nobody called ${handle} has a public profile`);
  const [stats, roles, issues, requests] = await Promise.all([
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
  ]);
  const counts = stats ? Object.fromEntries(Object.keys(ZERO).map((k) => [k, stats[k as keyof ContributorStats]])) as ContributorStats : ZERO;
  const staff = !!(u.is_admin || u.is_reviewer);
  const badges = [...(staff ? ["staff"] : []), ...[...roles].filter(() => !staff).sort()];
  return {
    handle: u.handle,
    avatar_url: u.avatar_url,
    joined: new Date(u.created_at).toISOString().slice(0, 7),
    roles: badges,
    counts,
    counted_at: stats?.updated_at ?? null,
    issues: issues.results.map((i) => ({ ref: `${i.ns}/${i.tool}`, number: i.number, kind: i.kind, status: i.status, title: i.title, created_at: i.created_at })),
    requests: requests.results.map((r) => ({ number: r.number, repo: r.repo_path, status: r.status, created_at: r.created_at })),
    // Worth a search engine's time once the community has recognised something they did.
    indexable: badges.length > 0 || counts.issues_confirmed > 0 || counts.requests_published > 0 || counts.issues_triaged > 0,
  };
}

/** Hides or shows the person's profile and avatar on their posts. */
export async function setProfileHidden(env: Env, user: User, hidden: boolean) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET profile_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, user.id),
    audit(env.DB, user.id, "user", hidden ? "profile.hide" : "profile.show", "user", user.id),
  ]);
}
