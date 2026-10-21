// /llms.txt (llmstxt.org): a map of the docs, schemas, policies and the most-installed tools and guides for agents.
import type { APIRoute } from "astro";
import { api, SITE_URL, type SearchResult } from "../lib/api";
import { cacheControl } from "../lib/page";
import { DOC_PAGES, POLICY_PAGES, markdownUrl, type MarkdownPage } from "../lib/markdown";

const START = ["getting-started", "cli", "automation", "results", "errors"];

const link = (page: MarkdownPage) => `- [${page.title}](${markdownUrl(page)})${page.description ? `: ${page.description}` : ""}`;

/** Tools or guides from the API; null when it is down or slow, so the file still answers. */
async function top(path: string): Promise<SearchResult["results"] | null> {
  try {
    return (await api<SearchResult>(path, { signal: AbortSignal.timeout(4000) })).results;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async () => {
  const [tools, guides] = await Promise.all([top("/tools?kind=tool&sort=installs&limit=50"), top("/tools?kind=guide&sort=installs&limit=20")]);
  const start = START.map((slug) => DOC_PAGES.find((p) => p.slug === slug)).filter((p): p is MarkdownPage => !!p);
  const rest = DOC_PAGES.filter((p) => !START.includes(p.slug));
  const sections: string[] = [
    "# OTInstaller",
    `> OTInstaller is a free, public registry of OSINT tools and investigation guides. Its command-line tool, \`ot\`, installs digest-pinned, signature-verified tools and runs them on your own machine in a locked-down container. Use it only for lawful investigation; see the [acceptable use policy](${SITE_URL}/policy/acceptable-use.md).`,
    "Every docs and policy page is also available as Markdown: add `.md` to its URL, or send `Accept: text/markdown`.",
    `## Start here\n\n${start.map(link).join("\n")}`,
    `## Docs\n\n${rest.map(link).join("\n")}`,
    [
      "## Schemas",
      "",
      `- [Manifest](${SITE_URL}/schema/v1.json): JSON Schema for otinstaller.yaml`,
      `- [Result envelope](${SITE_URL}/schema/envelope-v1.json): JSON Schema for the output of \`ot run --format json\``,
      `- [Run-all summary](${SITE_URL}/schema/run-all-v1.json): JSON Schema for the summary of \`ot run --all\`, \`ot playbook\` and \`ot auto\``,
      `- [Error](${SITE_URL}/schema/error-v1.json): JSON Schema for JSON errors from \`ot\` and the registry API`,
    ].join("\n"),
    `## Policies\n\n${POLICY_PAGES.map(link).join("\n")}`,
  ];
  if (tools?.length) sections.push(`## Popular tools\n\n${tools.map((t) => `- [${t.namespace}/${t.name}](${SITE_URL}/${t.namespace}/${t.name}): ${t.summary}`).join("\n")}`);
  if (guides?.length) sections.push(`## Guides\n\n${guides.map((g) => `- [${g.namespace}/${g.name}](${SITE_URL}/guides/${g.namespace}/${g.name}): ${g.title ? `${g.title}. ` : ""}${g.summary}`).join("\n")}`);
  sections.push(
    [
      "## Optional",
      "",
      `- [Full docs](${SITE_URL}/llms-full.txt): every docs and policy page in one file`,
      "- [OSINTverse](https://osintverse.com/llms.txt): paid lookups and cases",
    ].join("\n"),
  );
  // A copy missing the API sections is kept only briefly.
  return new Response(`${sections.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": cacheControl(tools && guides ? 3600 : 300) },
  });
};
