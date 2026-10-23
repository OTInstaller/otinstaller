// Markdown twins: `Accept: text/markdown` on docs, policy, publisher, tool and guide pages, and the /<ns>.md,
// /<ns>/<name>.md and /guides/<ns>/<name>/<page>.md URLs (built from the API).
import { defineMiddleware } from "astro:middleware";
import { markdownPage, markdownResponse, prefersMarkdown } from "./lib/markdown";
import { guideTwin, profileTwin, SLUG, toolTwin } from "./lib/twins";
import { canonicalRedirect } from "./lib/redirects";

/** First path segments that are site sections, not namespaces. */
const RESERVED = new Set(["docs", "policy", "schema", "admin", "category", "input", "settings", "transfers", "guides", "search", "import", "feedback", "dashboard", "removed", "publish", "tour", "otlite", "agents", "learn"]);

type Route = { kind: "tool"; ns: string; name: string } | { kind: "guide"; ns: string; name: string; page: string } | { kind: "profile"; ns: string };

/** Which tool or guide page a path is, and whether it is a .md twin URL; null for any other path. */
function route(pathname: string): { route: Route; md: boolean } | null {
  let segs: string[];
  try {
    segs = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const last = segs[segs.length - 1] ?? "";
  const md = last.endsWith(".md");
  if (md) segs[segs.length - 1] = last.slice(0, -3);
  if (segs[0] === "guides" && segs.length >= 3 && SLUG.test(segs[1]) && SLUG.test(segs[2])) {
    return { route: { kind: "guide", ns: segs[1], name: segs[2], page: segs.slice(3).join("/") }, md };
  }
  if (segs.length === 2 && !RESERVED.has(segs[0]) && SLUG.test(segs[0]) && SLUG.test(segs[1])) return { route: { kind: "tool", ns: segs[0], name: segs[1] }, md };
  if (segs.length === 1 && !RESERVED.has(segs[0]) && SLUG.test(segs[0])) return { route: { kind: "profile", ns: segs[0] }, md };
  return null;
}

/** Adds Vary: Accept to an HTML answer that has a Markdown twin at the same URL. */
function vary(res: Response): Response {
  try {
    res.headers.append("Vary", "Accept");
  } catch {
    // Immutable headers (a redirect or a static response): leave it as it is.
  }
  return res;
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname } = ctx.url;
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") return next();
  const redirect = canonicalRedirect(ctx.url);
  if (redirect) return redirect;
  const wantsMd = prefersMarkdown(ctx.request.headers.get("accept"));

  // The Markdown answer is private: shared caches (Cloudflare's included) don't key on Vary, so a public copy
  // could be handed to a browser asking for HTML on the same URL. The .md URLs are the cacheable form.
  const page = !pathname.endsWith(".md") ? markdownPage(pathname) : null;
  if (page) return wantsMd ? markdownResponse(page, true) : vary(await next());

  const found = route(pathname);
  if (!found) return next();
  const negotiated = !found.md;
  if (negotiated && !wantsMd) return vary(await next());
  const r = found.route;
  if (r.kind === "profile") return profileTwin(r.ns, negotiated);
  return r.kind === "tool" ? toolTwin(r.ns, r.name, negotiated) : guideTwin(r.ns, r.name, r.page, ctx.url.searchParams.get("v"), negotiated);
});
