// Anonymous public reads are answered from Cloudflare's edge cache for as long as their Cache-Control
// allows. Without it every page view and every crawler request for a filter combination on the site
// was a D1 query, and in October 2026 crawlers alone used up D1's daily read allowance. Every JSON read
// also gets an ETag, so a client that polls (a script, an agent) gets a 304 instead of the same body again.
import type { Env } from "./env";

const ORIGINAL_CC = "x-ot-cache-control";

/** The cache key: the URL plus which CORS answer the request gets (the site's, with credentials, or `*`). */
function cacheKey(req: Request, env: Env): Request {
  const url = new URL(req.url);
  url.searchParams.sort();
  url.searchParams.set("__cors", req.headers.get("origin") === env.SITE_URL ? "site" : "any");
  return new Request(url.toString(), { method: "GET" });
}

/** Adds a weak ETag, a hash of the body, to a successful JSON or text read. */
async function tagged(req: Request, res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (req.method !== "GET" || res.status !== 200 || res.headers.has("etag") || !/json|text/.test(type)) return res;
  const body = await res.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const out = new Response(body, res);
  out.headers.set("etag", `W/"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`);
  return out;
}

/** 304 Not Modified when the client sent the response's ETag in If-None-Match. */
function notModified(req: Request, res: Response): Response {
  const etag = res.headers.get("etag");
  const sent = req.headers.get("if-none-match");
  if (!etag || !sent || !sent.split(",").some((t) => t.trim() === etag || t.trim() === "*")) return res;
  const headers = new Headers();
  for (const h of ["etag", "cache-control", "vary", "x-edge-cache", "access-control-allow-origin", "access-control-allow-credentials"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(null, { status: 304, headers });
}

export async function edgeCached(req: Request, env: Env, ctx: ExecutionContext, handle: () => Promise<Response>): Promise<Response> {
  // Signed-in requests can see more (owner controls, private namespaces), so they always go to the API.
  if (env.EDGE_CACHE === "off" || req.method !== "GET" || req.headers.has("authorization") || req.headers.has("cookie")) {
    return notModified(req, await tagged(req, await handle()));
  }
  const cache = caches.default;
  const key = cacheKey(req, env);
  const hit = await cache.match(key);
  if (hit) {
    const res = new Response(hit.body, hit);
    // The zone's Browser Cache TTL rewrites Cache-Control on cached responses (to 4 hours); give browsers ours.
    const cc = res.headers.get(ORIGINAL_CC);
    if (cc) res.headers.set("cache-control", cc);
    res.headers.delete(ORIGINAL_CC);
    res.headers.set("x-edge-cache", "hit");
    return notModified(req, res);
  }
  const res = await tagged(req, await handle());
  const cc = res.headers.get("cache-control") ?? "";
  if (res.status === 200 && /\bpublic\b/.test(cc) && /max-age=\d*[1-9]/.test(cc) && !res.headers.has("set-cookie")) {
    const stored = new Response(res.clone().body, res);
    stored.headers.set(ORIGINAL_CC, cc);
    ctx.waitUntil(cache.put(key, stored));
  }
  return notModified(req, res);
}
