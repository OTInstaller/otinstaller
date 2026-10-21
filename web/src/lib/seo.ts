// schema.org JSON-LD builders and title helpers shared by the public pages. Only facts the page itself shows go in:
// no ratings, no review counts, nothing the registry does not check. docs/seo.md lists what each page type emits.
import { SITE_URL } from "./api";
import type { ToolSummary } from "./api";

/** The registry as an Organization (the home page, and `publisher` on articles). */
export const ORGANIZATION = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: "OTInstaller",
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/logo.svg`,
  parentOrganization: { "@type": "Organization", name: "OSINTverse", url: "https://osintverse.com" },
  sameAs: ["https://github.com/OTInstaller/otinstaller", "https://osintverse.com"],
  contactPoint: [{ "@type": "ContactPoint", contactType: "customer support", email: "support@otinstaller.com" }],
};

/** A BreadcrumbList from (label, site path) pairs; the last item is the current page. */
export function breadcrumbs(items: [label: string, path: string][]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE_URL}${path}` })),
  };
}

/** An ItemList of tools or guides for a landing page, in the order shown. */
export function itemList(name: string, items: ToolSummary[]): Record<string, unknown> {
  return {
    "@type": "ItemList",
    name,
    numberOfItems: items.length,
    itemListElement: items.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE_URL}${t.kind === "guide" ? `/guides/${t.namespace}/${t.name}` : `/${t.namespace}/${t.name}`}`,
      name: t.kind === "guide" ? (t.title ?? `${t.namespace}/${t.name}`) : t.name,
    })),
  };
}

/** Wraps one or more schema.org objects in a graph with the context, the shape Base.astro prints. */
export function graph(...nodes: Record<string, unknown>[]): Record<string, unknown> {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/** FAQPage from (question, answer) pairs; answers are plain text or HTML. */
export function faqPage(pairs: [question: string, answer: string][]): Record<string, unknown> {
  return {
    "@type": "FAQPage",
    mainEntity: pairs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
}

/** (question, answer) pairs from a Markdown page whose `##` headings are questions: the answer is the text under each,
 * with links reduced to their text and code marks removed. Headings that are not questions are skipped. */
export function faqFromMarkdown(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const block of body.split(/^## /m).slice(1)) {
    const nl = block.indexOf("\n");
    const q = (nl < 0 ? block : block.slice(0, nl)).trim();
    if (!q.endsWith("?")) continue;
    const a = (nl < 0 ? "" : block.slice(nl + 1))
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (a) out.push([q, a]);
  }
  return out;
}

/** Cuts text at a word boundary so a title stays readable in a results page (search engines show about 60 characters). */
export function clip(text: string, max = 60): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[,;:.\s]+$/, "")}…`;
}

/** "a" or "an" for a label. */
export const article = (label: string) => (/^[aeiou]/i.test(label) ? "an" : "a");
