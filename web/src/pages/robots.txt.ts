import type { APIRoute } from "astro";

// `/*?` keeps crawlers off filtered and sorted views (any query string); the sitemap lists every page worth
// crawling. Crawlers walking every filter combination used up the registry database's daily reads.
export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nDisallow: /dashboard\nDisallow: /settings/\nDisallow: /import\nDisallow: /*?\nSitemap: ${new URL("/sitemap.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
