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
 * The start of a rendered fragment as one line of text, for previews such as release notes: headings are left out,
 * list items are separated by semicolons, and long text is cut at a word with an ellipsis.
 */
export function excerpt(html: string, max = 280): string {
  const text = textOf(html.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, " ").replace(/<\/li>/gi, "; ").replace(/<\/p>/gi, " "))
    .replace(/;(\s*;)+/g, ";")
    .replace(/[\s;]+$/, "");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s;,.:]+$/, "")}…`;
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
