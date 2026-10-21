// One address per page: www., plain http and a trailing slash all answer with a permanent redirect to the canonical
// form, so search engines and caches see a single URL (the middleware applies it to GET and HEAD).
import { SITE_URL } from "./api";

const SITE_HOST = new URL(SITE_URL).host;

/**
 * The redirect a request needs to reach its canonical address, or null when it is already there. Only the production
 * host and its www. twin are touched (a local dev server has another host); the query string is kept.
 */
export function canonicalRedirect(url: URL, siteHost = SITE_HOST): Response | null {
  const onSite = url.host === siteHost || url.host === `www.${siteHost}`;
  const wrongHost = onSite && (url.host !== siteHost || url.protocol === "http:");
  const slash = url.pathname.length > 1 && url.pathname.endsWith("/");
  if (!wrongHost && !slash) return null;
  const to = new URL(url);
  if (wrongHost) {
    to.host = siteHost;
    to.protocol = "https:";
  }
  if (slash) to.pathname = url.pathname.replace(/\/+$/, "");
  return new Response(null, { status: 301, headers: { Location: to.toString(), "Cache-Control": "public, max-age=3600" } });
}
