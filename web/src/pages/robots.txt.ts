import type { APIRoute } from "astro";

// `/*?` keeps crawlers off filtered and sorted views (any query string); the sitemap lists every page worth
// crawling. Crawlers walking every filter combination used up the registry database's daily reads. Agents are
// welcome: the comment points them at llms.txt.
export const GET: APIRoute = ({ site }) =>
  new Response(`# For AI agents and LLMs: ${new URL("/llms.txt", site)}\nUser-agent: *\nDisallow: /dashboard\nDisallow: /settings/\nDisallow: /import\nDisallow: /*?\nSitemap: ${new URL("/sitemap.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
