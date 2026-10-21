// Small fixes to HTML the registry renders (READMEs, guide and docs pages) before it goes into a page that
// already has its own <h1>: a page must have one top heading for search engines and screen readers.

/** The text of an HTML fragment, tags removed and entities for the common characters decoded. */
export function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps the page's own title the only h1. When `title` is given and the body starts with an h1 that says the same
 * thing, that heading is dropped (the body's h2s are then the right level under the page title). If an h1 still
 * remains, every heading moves down one level (h1 → h2 … h5 → h6).
 */
export function demoteHeadings(html: string, title?: string): string {
  let out = html;
  if (title) {
    const m = /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i.exec(out);
    if (m && textOf(m[1]!).toLowerCase() === title.trim().toLowerCase()) out = out.slice(m[0].length);
  }
  if (!/<h1\b/i.test(out)) return out;
  return out.replace(/<(\/?)h([1-5])\b/gi, (_, slash: string, n: string) => `<${slash}h${Number(n) + 1}`);
}
