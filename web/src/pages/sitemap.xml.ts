// sitemap.xml from the API: landing pages that list something, every listed tool and guide, and the docs. Cached for
// a day at the edge, which is the plan's nightly regeneration. Input types with no tools and the generic value types
// (string, integer…) are left out: their pages are noindex.
import type { APIRoute } from "astro";
import { api, type Facets, type SearchResult, type Types } from "../lib/api";
import { GENERIC_INPUTS } from "../lib/landing";
import { OTLITE_TOOLS, toolPath } from "../lib/otlite";

const DOCS = ["", "/quick-start", "/getting-started", "/otlite", "/cli", "/agents", "/mcp-tools", "/automation", "/results", "/api", "/manifest", "/publishing", "/guides", "/errors", "/security", "/faq"];
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
  const [types, tools, guides, facets] = await Promise.all([api<Types>("/types"), all("/tools?kind=tool"), all("/guides"), api<Facets>("/facets?kind=tool").catch(() => null)]);
  const listed = (counts: Record<string, number> | undefined, v: string) => !counts || (counts[v] ?? 0) > 0;
  const paths = [
    "/", "/search", "/guides", "/publish", "/tour", "/otlite", "/otlite/tools", "/agents",
    ...OTLITE_TOOLS.map((t) => toolPath(t.name)),
    ...types.inputs.filter((t) => !GENERIC_INPUTS.has(t) && listed(facets?.inputs, t)).map((t) => `/input/${t}`),
    ...types.categories.filter((c) => listed(facets?.categories, c)).map((c) => `/category/${c}`),
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
