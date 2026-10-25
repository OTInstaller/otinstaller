// IndexNow (https://www.indexnow.org): tells Bing, Yandex, Seznam, Naver and the other participating search engines
// which otinstaller.com pages changed, so a new release or a takedown shows in their results within minutes instead of
// at the next crawl of the sitemap. Events queue the site paths they changed (indexnow_queue, one row per path); the
// 15-minute cron sends them in one request. The key is public by design: the site serves it at /<key>.txt (web/public/
// in the site's repository), and INDEXNOW_KEY (wrangler.jsonc) must name the same file.
import { deps, type Env } from "./env";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** The protocol allows 10,000 URLs a request; a run sends far fewer, and D1 batches stay small. */
const BATCH = 500;
/** Paths that could not be sent for a week (a missing key file, an endpoint that keeps refusing) are dropped. */
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
/** Generic value types have noindex landing pages (the site's GENERIC_INPUTS). */
const GENERIC_INPUTS = new Set(["string", "integer", "boolean", "enum"]);

/** On only with a key and a public https site: local and test runs (SITE_URL on 127.0.0.1, no key) queue nothing. */
export function indexNowEnabled(env: Env): boolean {
  if (!env.INDEXNOW_KEY) return false;
  const site = new URL(env.SITE_URL);
  return site.protocol === "https:" && site.hostname !== "localhost" && site.hostname !== "127.0.0.1";
}

/** A package's own pages: a tool's page and its versions, or a guide's first page. */
export function packagePaths(kind: string, namespace: string, name: string): string[] {
  return kind === "guide" ? [`/guides/${namespace}/${name}`] : [`/${namespace}/${name}`, `/${namespace}/${name}/versions`];
}

/**
 * The pages a newly announced version changed: the package's own, its publisher's and /new, and for a package's
 * first version the landing pages of the input types and categories that now list it.
 */
export function releasePaths(p: { kind: string; namespace: string; name: string; first: boolean; inputs?: string[]; categories?: string[] }): string[] {
  const paths = [...packagePaths(p.kind, p.namespace, p.name), `/${p.namespace}`, "/new"];
  if (p.first) {
    for (const t of p.inputs ?? []) if (!GENERIC_INPUTS.has(t)) paths.push(`/input/${t}`);
    for (const c of p.categories ?? []) paths.push(`/category/${c}`);
    if (p.kind === "guide") paths.push("/guides");
  }
  return paths;
}

/** Statements that queue paths for the next submission, to run in the caller's batch (none when IndexNow is off). */
export function indexNowStatements(env: Env, paths: string[], now = Date.now()): D1PreparedStatement[] {
  if (!indexNowEnabled(env)) return [];
  return [...new Set(paths)].map((path) =>
    env.DB.prepare(`INSERT INTO indexnow_queue (path, queued_at) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET queued_at = excluded.queued_at`)
      .bind(path, now),
  );
}

/** Queues paths on their own; a failure is logged and never fails the event that changed them. */
export async function queueIndexNow(env: Env, paths: string[], now = Date.now()): Promise<void> {
  const stmts = indexNowStatements(env, paths, now);
  if (stmts.length) await env.DB.batch(stmts).catch((e) => console.error("queueing IndexNow paths failed", e));
}

/**
 * Sends what is queued in one request (from the 15-minute cron). 200 and 202 (the key is still being checked) clear
 * the rows sent; 400 and 422 (a URL or the key doesn't fit the host) drop them, as sending them again can't help; 403
 * (key file not found), 429 and server errors keep them for the next run, up to a week.
 */
export async function flushIndexNow(env: Env, now = Date.now()): Promise<{ sent: number; status?: number }> {
  if (!indexNowEnabled(env)) return { sent: 0 };
  const db = env.DB;
  await db.prepare(`DELETE FROM indexnow_queue WHERE queued_at < ?`).bind(now - MAX_AGE).run();
  const rows = (await db.prepare(`SELECT path FROM indexnow_queue WHERE queued_at <= ? ORDER BY queued_at, path LIMIT ?`)
    .bind(now, BATCH).all<{ path: string }>()).results;
  if (!rows.length) return { sent: 0 };
  const site = new URL(env.SITE_URL);
  const res = await deps.fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: site.host,
      key: env.INDEXNOW_KEY,
      keyLocation: new URL(`/${env.INDEXNOW_KEY}.txt`, site).toString(),
      urlList: rows.map((r) => new URL(r.path, site).toString()),
    }),
  });
  const done = res.ok || res.status === 400 || res.status === 422;
  if (!res.ok) console.error(`IndexNow answered ${res.status} for ${rows.length} URLs${done ? "; dropped them" : "; will try again"}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  if (!done) return { sent: 0, status: res.status };
  // A path changed again after it was read stays queued for the next run.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    stmts.push(db.prepare(`DELETE FROM indexnow_queue WHERE queued_at <= ? AND path IN (${chunk.map(() => "?").join(", ")})`).bind(now, ...chunk.map((r) => r.path)));
  }
  await db.batch(stmts);
  return { sent: res.ok ? rows.length : 0, status: res.status };
}
