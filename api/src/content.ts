// Guide pages, tool docs and READMEs: rendering Markdown to sanitized HTML, the content rules, and
// finding personal data in examples. Pure functions; storing and link checking live in guides.ts.
import { Marked, type Tokens } from "marked";
import type { Problem } from "./lib/manifest";

export const MAX_PAGE_BYTES = 200 * 1024;
export const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp", ".svg"];

export interface RenderContext {
  /** The page's file in the repository, e.g. "docs/02-passive-checks.md" (or "README.md"). */
  file: string;
  /** The content root the navigation is relative to, e.g. "docs/"; "" for a README. */
  root: string;
  /** Navigation paths, relative to root. */
  pages: Set<string>;
  /** Where another page of the same guide or docs is shown. */
  pageUrl: (path: string) => string;
  /** Where a file in the repository (an image, a script) can be fetched at this release. */
  fileUrl: (repoPath: string) => string;
  /** Links to Markdown files outside the navigation count as missing pages (not for READMEs). */
  strict?: boolean;
}

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

export interface FoundLink {
  url: string;
  line: number | null;
  /** Set for links to pages that are not part of the guide. */
  missing?: boolean;
}

export interface Rendered {
  title: string;
  html: string;
  text: string;
  words: number;
  toc: TocEntry[];
  links: FoundLink[];
  problems: Problem[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripTags = (html: string) => unesc(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Raw HTML is never rendered, but these tags or attributes mean the author tried to embed active content.
const DANGEROUS_HTML = /<\s*\/?\s*(script|iframe|object|embed|style|form|input|button|frame|frameset|meta|link|base|svg|math)\b|\son[a-z]+\s*=|javascript:/i;
const ADMONITION = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

/** Resolves a relative href against a directory, POSIX style; null when it leaves the repository. */
export function resolvePath(dir: string, href: string): string | null {
  const parts = href.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/") + 1);
const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function lineOf(source: string, needle: string): number | null {
  const i = source.indexOf(needle);
  return i < 0 ? null : source.slice(0, i).split("\n").length;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-") || "section";
}

/** A title for a page without a heading: "02-passive-checks.md" -> "Passive checks". */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop()!.replace(/\.md$/i, "").replace(/^\d+[-_.\s]*/, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0]!.toUpperCase() + base.slice(1) : path;
}

/**
 * Renders one Markdown page (CommonMark + GFM, with `> [!NOTE]` admonitions) to HTML that is safe to
 * serve: raw HTML is shown as text, only http(s), mailto and in-repo links survive, links to other pages
 * point at the site, and repository images load from the tagged commit. External images become links.
 */
export function renderPage(md: string, ctx: RenderContext): Rendered {
  const toc: TocEntry[] = [];
  const links: FoundLink[] = [];
  const problems: Problem[] = [];
  const ids = new Map<string, number>();
  const seen = new Set<string>();
  let title: string | null = null;
  const where = (field: string) => `${ctx.file}${field}`;

  const addLink = (url: string, raw: string, missing = false) => {
    const key = `${url}|${missing}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ url, line: lineOf(md, raw), ...(missing ? { missing } : {}) });
  };

  /** What an href becomes: dropped (unsafe), external, a page of this guide, or a repository file. */
  const classify = (href: string): { href: string | null; external: boolean } => {
    const h = href.trim();
    if (h.startsWith("#")) return { href: h, external: false };
    if (/^https?:\/\//i.test(h)) {
      addLink(h, href);
      return { href: h, external: true };
    }
    if (/^mailto:/i.test(h)) return { href: h, external: false };
    if (hasScheme(h) || h.startsWith("//")) return { href: null, external: false };
    const [pathPart, frag] = h.split("#", 2) as [string, string | undefined];
    const target = resolvePath(dirOf(ctx.file), decodeURIComponent(pathPart.split("?")[0]!));
    const anchor = frag ? `#${frag}` : "";
    if (target !== null && target.startsWith(ctx.root) && ctx.pages.has(target.slice(ctx.root.length))) {
      return { href: ctx.pageUrl(target.slice(ctx.root.length)) + anchor, external: false };
    }
    if (target === null || (ctx.strict !== false && /\.md$/i.test(target))) {
      addLink(h, href, true);
      return { href: null, external: false };
    }
    return { href: ctx.fileUrl(target), external: false };
  };

  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const text = stripTags(inner);
        let id = slugify(text);
        const n = ids.get(id) ?? 0;
        ids.set(id, n + 1);
        if (n > 0) id = `${id}-${n}`;
        if (depth === 1 && title === null) title = text;
        if (depth <= 3) toc.push({ depth, id, text });
        return `<h${depth} id="${esc(id)}">${inner}</h${depth}>\n`;
      },
      link({ href, title: t, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = classify(href);
        if (target.href === null) return inner;
        const rel = target.external ? ' rel="nofollow noopener noreferrer"' : "";
        return `<a href="${esc(target.href)}"${t ? ` title="${esc(t)}"` : ""}${rel}>${inner}</a>`;
      },
      image({ href, title: t, text }: Tokens.Image) {
        const h = href.trim();
        if (/^https?:\/\//i.test(h)) {
          // No hotlinked images: they would track readers. Authors keep images in the repository.
          addLink(h, href);
          return `<a href="${esc(h)}" rel="nofollow noopener noreferrer">${esc(text || h)}</a>`;
        }
        const target = hasScheme(h) ? null : resolvePath(dirOf(ctx.file), decodeURIComponent(h.split(/[?#]/)[0]!));
        if (target === null || !IMAGE_TYPES.some((ext) => target.toLowerCase().endsWith(ext))) {
          problems.push({
            code: "content_image_type", path: where(""), message: `image ${h} is not a PNG, JPEG, WebP or SVG file in the repository`,
            hint: "keep images in the repository as .png, .jpg, .webp or .svg",
          });
          return esc(text);
        }
        return `<img src="${esc(ctx.fileUrl(target))}" alt="${esc(text)}"${t ? ` title="${esc(t)}"` : ""} loading="lazy">`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        if (DANGEROUS_HTML.test(text)) {
          problems.push({
            code: "content_raw_html", path: where(lineOf(md, text.trim()) ? `:${lineOf(md, text.trim())}` : ""),
            message: `raw HTML is not allowed: ${text.trim().slice(0, 80)}`, hint: "use Markdown; scripts, iframes, forms and styles are never rendered",
          });
        }
        if (/^<br\s*\/?>$/i.test(text.trim())) return "<br>";
        return esc(text);
      },
      code({ text, lang }: Tokens.Code) {
        const l = (lang ?? "").split(/\s/)[0];
        return `<pre><code${l ? ` class="language-${esc(l)}"` : ""}>${esc(text)}</code></pre>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const body = this.parser.parse(tokens);
        const m = ADMONITION.exec(body);
        if (!m) return `<blockquote>\n${body}</blockquote>\n`;
        const kind = m[1]!.toLowerCase();
        return `<div class="admonition admonition-${kind}"><p class="admonition-title">${kind[0]!.toUpperCase()}${kind.slice(1)}</p>\n<p>${body.slice(m[0].length)}</div>\n`;
      },
    },
  });

  const html = marked.parse(md) as string;
  const text = stripTags(html);
  return {
    title: title ?? toc[0]?.text ?? titleFromPath(ctx.file),
    html,
    text,
    words: text ? text.split(" ").length : 0,
    toc,
    links,
    problems,
  };
}

/** The content rules that apply to every page of a guide or tool docs. */
export function pageProblems(file: string, md: string, rendered: Rendered): Problem[] {
  const ps: Problem[] = [];
  const bytes = new TextEncoder().encode(md).length;
  if (bytes > MAX_PAGE_BYTES) {
    ps.push({ code: "content_page_too_large", path: file, message: `${file} is ${Math.ceil(bytes / 1024)} KB; pages can be at most 200 KB`, hint: "split it into several pages" });
  }
  return [...ps, ...rendered.problems];
}

// ---------- personal data ----------

export interface PiiHit {
  page: string;
  line: number;
  kind: "email" | "phone" | "name_address";
  match: string;
  /** The line, shortened, with the match marked «like this» for the reviewer. */
  excerpt: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const SAFE_EMAIL_DOMAINS = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local|users\.noreply\.github\.com|noreply\.github\.com)$/i;
const PHONE = /(?<![\w/.:#=@-])\+?\(?\d[\d ().-]{7,18}\d(?![\w/:@-]|\.\d)/g;
const STREET = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Close)\b\.?/;
const NAME = /\b([A-Z][a-z]{1,15}) ([A-Z][a-z]{1,20})\b/g;
// Capitalised word pairs that are not people: street words, directions, common sentence starts, the fictional Does.
const NOT_NAMES = new Set(
  "Street St Avenue Ave Road Rd Boulevard Blvd Lane Ln Drive Dr Court Ct Way Place Pl Terrace Close North South East West New San Los Las Main The This That These Those When Where What Then Use See Note Warning Step Doe Example Fictional Test City Town County State Suite Apt".split(" "),
);

function excerpt(line: string, match: string): string {
  const i = line.indexOf(match);
  const start = Math.max(0, i - 60);
  const end = Math.min(line.length, i + match.length + 60);
  return `${start > 0 ? "…" : ""}${line.slice(start, i)}«${match}»${line.slice(i + match.length, end)}${end < line.length ? "…" : ""}`.trim();
}

function isFakePhone(m: string, digits: string): boolean {
  if (digits.length < 10 || digits.length > 15) return true;
  // Bare digit runs are IDs and timestamps far more often than phone numbers.
  if (!m.startsWith("+") && !/[ ().-]/.test(m)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(m)) return true; // an IPv4 address
  if (/^(\d)\1+$/.test(digits) || "01234567890123456789".includes(digits)) return true;
  return /55501\d\d$/.test(digits); // the North American fictional range 555-0100..0199
}

/**
 * Finds what looks like real people's data in a page: email addresses outside the example domains,
 * phone numbers, and capitalised names on the same line as a street address. Hits never block a
 * release; they go to a reviewer with the lines marked.
 */
export function findPersonalData(md: string, page: string, limit = 50): PiiHit[] {
  const hits: PiiHit[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i]!;
    const add = (kind: PiiHit["kind"], match: string, marked = match) => hits.push({ page, line: i + 1, kind, match, excerpt: excerpt(line, marked) });
    for (const m of line.matchAll(EMAIL)) {
      const domain = m[1]!;
      const local = m[0].slice(0, m[0].length - domain.length - 1);
      if (SAFE_EMAIL_DOMAINS.test(domain) || (local === "git" && /^git(hub|lab)\.com$/i.test(domain))) continue;
      add("email", m[0]);
    }
    for (const m of line.matchAll(PHONE)) {
      const raw = m[0].trim();
      if (!isFakePhone(raw, raw.replace(/\D/g, ""))) add("phone", raw);
    }
    const street = STREET.exec(line);
    if (street) {
      const rest = line.replace(street[0], " ");
      for (const n of rest.matchAll(NAME)) {
        if (NOT_NAMES.has(n[1]!) || NOT_NAMES.has(n[2]!)) continue;
        add("name_address", `${n[0]} / ${street[0]}`, street[0]);
        break;
      }
    }
  }
  return hits.slice(0, limit);
}
