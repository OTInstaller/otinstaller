// Anonymous public reads are answered from Cloudflare's edge cache for as long as their Cache-Control
// allows. Without it every page view and every crawler request for a filter combination on the site
// was a D1 query, and in October 2026 crawlers alone used up D1's daily read allowance.
import type { Env } from "./env";

/** The cache key: the URL plus which CORS answer the request gets (the site's, with credentials, or `*`). */
function cacheKey(req: Request, env: Env): Request {
  const url = new URL(req.url);
  url.searchParams.sort();
  url.searchParams.set("__cors", req.headers.get("origin") === env.SITE_URL ? "site" : "any");
  return new Request(url.toString(), { method: "GET" });
}

export async function edgeCached(req: Request, env: Env, ctx: ExecutionContext, handle: () => Promise<Response>): Promise<Response> {
  // Signed-in requests can see more (owner controls, private namespaces), so they always go to the API.
  if (env.EDGE_CACHE === "off" || req.method !== "GET" || req.headers.has("authorization") || req.headers.has("cookie")) {
    return handle();
  }
  const cache = caches.default;
  const key = cacheKey(req, env);
  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("x-edge-cache", "hit");
    return res;
  }
  const res = await handle();
  const cc = res.headers.get("cache-control") ?? "";
  if (res.status === 200 && /\bpublic\b/.test(cc) && /max-age=\d*[1-9]/.test(cc) && !res.headers.has("set-cookie")) {
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}
