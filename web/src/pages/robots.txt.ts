import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nDisallow: /dashboard\nDisallow: /settings/\nDisallow: /import\nSitemap: ${new URL("/sitemap.xml", site)}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
