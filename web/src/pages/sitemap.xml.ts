// sitemap.xml from the API: landing pages, every listed tool and guide, and the docs. Cached for a day at the
// edge, which is the plan's nightly regeneration.
import type { APIRoute } from "astro";
import { api, type SearchResult, type Types } from "../lib/api";

const DOCS = ["", "/getting-started", "/cli", "/agents", "/mcp-tools", "/automation", "/results", "/api", "/manifest", "/publishing", "/guides", "/errors", "/security", "/faq"];
const POLICIES = ["/acceptable-use", "/terms", "/privacy", "/takedown", "/transparency"];

async function all(path: string) {
  const out: SearchResult["results"] = [];
  let cursor: string | undefined;
  do {
    const page = await api<SearchResult>(`${path}${path.includes("?") ? "&" : "?"}limit=100&sort=updated${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor && out.length < 5000);
  return out;
}

export const GET: APIRoute = async ({ site }) => {
  const [types, tools, guides] = await Promise.all([api<Types>("/types"), all("/tools?kind=tool"), all("/guides")]);
  const paths = [
    "/", "/search", "/guides", "/publish",
    ...types.inputs.map((t) => `/input/${t}`),
    ...types.categories.map((c) => `/category/${c}`),
    ...tools.map((t) => `/${t.namespace}/${t.name}`),
    ...guides.map((g) => `/guides/${g.namespace}/${g.name}`),
    ...[...new Set([...tools, ...guides].map((t) => t.namespace))].map((n) => `/${n}`),
    ...DOCS.map((d) => `/docs${d}`),
    ...POLICIES.map((p) => `/policy${p}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
    .map((p) => `  <url><loc>${new URL(p, site).toString().replace(/&/g, "&amp;")}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
};
