// The docs and policy pages as plain Markdown, for the .md twins, content negotiation, llms.txt and llms-full.txt.
import { SITE_URL } from "./api";

export interface MarkdownPage {
  /** The page's path on the site, e.g. /docs/cli or /docs for the index. */
  path: string;
  /** The file name without .md, e.g. cli or index. */
  slug: string;
  section: "docs" | "policy";
  title: string;
  description?: string;
  /** The source with its frontmatter removed. */
  body: string;
}

// The raw sources are bundled at build time, so the Worker never reads files.
const docs = import.meta.glob<string>("../pages/docs/*.md", { query: "?raw", import: "default", eager: true });
const policies = import.meta.glob<string>("../pages/policy/*.md", { query: "?raw", import: "default", eager: true });

/** Splits simple `key: value` frontmatter (all the docs use) from the body. */
function parse(source: string): { meta: Record<string, string>; body: string } {
  const text = source.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function load(files: Record<string, string>, section: MarkdownPage["section"], order: string[]): MarkdownPage[] {
  const pages = Object.entries(files).map(([file, source]) => {
    const slug = file.replace(/^.*\//, "").replace(/\.md$/, "");
    const { meta, body } = parse(source);
    const path = section === "docs" && slug === "index" ? "/docs" : `/${section}/${slug}`;
    return { path, slug, section, title: meta.title ?? slug, description: meta.description || undefined, body };
  });
  const rank = (slug: string) => (order.includes(slug) ? order.indexOf(slug) : order.length);
  return pages.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
}

/** Every docs page, in the order of the docs nav; pages not in that list follow alphabetically. */
export const DOC_PAGES = load(docs, "docs", ["index", "getting-started", "cli", "agents", "mcp-tools", "automation", "results", "manifest", "publishing", "guides", "errors", "security", "faq"]);
/** Every Markdown policy page (transparency is a live page and has no twin). */
export const POLICY_PAGES = load(policies, "policy", ["acceptable-use", "terms", "privacy", "takedown"]);

/** The page for a site path (/docs, /docs/index, /docs/cli, /policy/terms), or null. */
export function markdownPage(path: string): MarkdownPage | null {
  const p = path.replace(/\/+$/, "").replace(/\.md$/, "") || "/";
  const norm = p === "/docs/index" ? "/docs" : p;
  return [...DOC_PAGES, ...POLICY_PAGES].find((page) => page.path === norm) ?? null;
}

/** The absolute URL of a page's Markdown twin (/docs.md for the docs index). */
export function markdownUrl(page: MarkdownPage): string {
  return `${SITE_URL}${page.path}.md`;
}

/** A page as Markdown: a title heading, the description as the first paragraph, then the body. Site-relative
 * links become absolute, so the text still works once copied out of the site (llms-full.txt, an agent's context). */
export function renderMarkdown(page: MarkdownPage, source = false): string {
  const parts = [`# ${page.title}`];
  if (source) parts.push(`Source: ${SITE_URL}${page.path}`);
  if (page.description) parts.push(page.description);
  parts.push(page.body.replace(/\]\(\/(?!\/)/g, `](${SITE_URL}/`));
  return `${parts.join("\n\n")}\n`;
}

/** A Markdown response; `negotiated` ones answer a page URL by Accept header, so no shared cache may keep them. */
export function markdownResponse(page: MarkdownPage, negotiated = false): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": negotiated ? "private, max-age=300" : "public, max-age=300, s-maxage=3600",
    Link: `<${SITE_URL}${page.path}>; rel="canonical"`,
  };
  if (negotiated) headers.Vary = "Accept";
  return new Response(renderMarkdown(page), { headers });
}

/** Whether an Accept header prefers text/markdown over text/html (by q value, then by order). */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let md: { q: number; i: number } | null = null;
  let html: { q: number; i: number } | null = null;
  const parts = accept.split(",");
  for (let i = 0; i < parts.length; i++) {
    const [type, ...params] = parts[i].trim().toLowerCase().split(";");
    const qp = params.map((s) => s.trim()).find((s) => s.startsWith("q="));
    const q = qp ? Number(qp.slice(2)) : 1;
    const entry = { q: Number.isFinite(q) ? q : 0, i };
    if (type.trim() === "text/markdown") md = entry;
    else if (type.trim() === "text/html") html = entry;
  }
  if (!md || md.q <= 0) return false;
  if (!html) return true;
  return md.q > html.q || (md.q === html.q && md.i < html.i);
}
