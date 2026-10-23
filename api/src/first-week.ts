// A new version's first week: what signed-in people said about it ("works for me", "broken for me") since it came
// out, so a regression shows while people are still deciding whether to update. The status line (community.ts), the
// versions list (index.ts) and the activity feed (activity.ts) carry it, and `ot outdated` reads it from the versions
// list. The counts come from the confirmations table (migration 0016): counts, never a score.

export const FIRST_WEEK = 7 * 86_400_000;

/** Whether a version published at `publishedAt` is still in its first week. */
export const inFirstWeek = (publishedAt: number | null | undefined, now = Date.now()) => !!publishedAt && publishedAt <= now && now - publishedAt < FIRST_WEEK;

export type FirstWeek = { works: number; broken: number; ends_at: number };

/** Works and broken counts for each of these versions still in its first week, by version id. */
export async function firstWeekCounts(db: D1Database, versions: { id: string; published_at: number | null }[], now = Date.now()): Promise<Map<string, FirstWeek>> {
  const fresh = versions.filter((v) => inFirstWeek(v.published_at, now));
  const out = new Map(fresh.map((v): [string, FirstWeek] => [v.id, { works: 0, broken: 0, ends_at: v.published_at! + FIRST_WEEK }]));
  if (!fresh.length) return out;
  const rows = (await db.prepare(
    `SELECT version_id, result, COUNT(*) AS n FROM confirmations WHERE version_id IN (${fresh.map(() => "?").join(", ")}) GROUP BY version_id, result`,
  ).bind(...fresh.map((v) => v.id)).all<{ version_id: string; result: "works" | "broken"; n: number }>()).results;
  for (const r of rows) out.get(r.version_id)![r.result] += r.n;
  return out;
}
