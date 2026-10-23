// /llms.txt (llmstxt.org): a map of the docs, schemas, policies and the most-installed tools and guides for agents.
import type { APIRoute } from "astro";
import { api, API_URL, SITE_URL, type PublisherList, type SearchResult } from "../lib/api";
import { cacheControl } from "../lib/page";
import { DOC_PAGES, POLICY_PAGES, markdownUrl, type MarkdownPage } from "../lib/markdown";
import { INPUT_LANDING } from "../lib/landing";
import { OTLITE_TOOLS, firstSentence, toolPath } from "../lib/otlite";

const START = ["getting-started", "otlite", "agents", "mcp-tools", "cli", "automation", "results", "errors", "api"];

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
  const [tools, guides, publishers] = await Promise.all([
    top("/tools?kind=tool&sort=installs&limit=50"),
    top("/tools?kind=guide&sort=installs&limit=20"),
    api<PublisherList>("/namespaces", { signal: AbortSignal.timeout(4000) }).then((r) => r.namespaces, () => null),
  ]);
  const start = START.map((slug) => DOC_PAGES.find((p) => p.slug === slug)).filter((p): p is MarkdownPage => !!p);
  const rest = DOC_PAGES.filter((p) => !START.includes(p.slug));
  const sections: string[] = [
    "# OTInstaller",
    `> OTInstaller is a free, public registry of OSINT tools and investigation guides. Its command-line tool, \`ot\`, installs digest-pinned, signature-verified tools and runs them on your own machine in a locked-down container. Use it only for lawful investigation; see the [acceptable use policy](${SITE_URL}/policy/acceptable-use.md).`,
    `An MCP client can search the registry through the read-only remote server at ${API_URL}/mcp (Streamable HTTP, no account). Installing and running tools needs \`ot mcp\` on the person's machine; see ${SITE_URL}/docs/agents.md.`,
    `Agents: start at ${SITE_URL}/agents.md. It says how to connect, what needs the person's consent, how to use \`ot\` and the API without MCP, and the rules to follow.`,
    "Every docs, policy, publisher, tool and guide page is also available as Markdown: add `.md` to its URL (`/<namespace>.md` for a publisher, `/<namespace>/<name>.md` for a tool, `/guides/<namespace>/<name>/<page>.md` for a guide page), or send `Accept: text/markdown`.",
    `## Start here\n\n${start.map(link).join("\n")}`,
    `## Docs\n\n${rest.map(link).join("\n")}`,
    [
      "## API and schemas",
      "",
      `- [OpenAPI](${API_URL}/v1/openapi.json): OpenAPI 3.1 description of the registry API`,
      `- [Types and pivot map](${API_URL}/v1/types): input types, entity types, and which input types each entity type can feed`,
      `- [Manifest](${SITE_URL}/schema/v1.json): JSON Schema for otinstaller.yaml`,
      `- [Result envelope](${SITE_URL}/schema/envelope-v1.json): JSON Schema for the output of \`ot run --format json\``,
      `- [Run-all summary](${SITE_URL}/schema/run-all-v1.json): JSON Schema for the summary of \`ot run --all\`, \`ot playbook\` and \`ot auto\``,
      `- [Error](${SITE_URL}/schema/error-v1.json): JSON Schema for JSON errors from \`ot\` and the registry API`,
      `- [Activity](${API_URL}/v1/activity): what changed across the registry, newest first (releases, yanks, deprecations, transfers)`,
      `- [Feed](${SITE_URL}/feed.json): the same as JSON Feed 1.1 (also ${SITE_URL}/feed.atom); add \`/feed.json\` to a publisher, tool or \`/input/<type>\` page URL for its own feed`,
    ].join("\n"),
    `## Policies\n\n${POLICY_PAGES.map(link).join("\n")}`,
    `## Tools by what you have\n\n${Object.entries(INPUT_LANDING).map(([type, l]) => `- [${l.title}](${SITE_URL}/input/${type}): ${l.description}`).join("\n")}`,
  ];
  if (tools?.length) sections.push(`## Popular tools\n\n${tools.map((t) => `- [${t.namespace}/${t.name}](${SITE_URL}/${t.namespace}/${t.name}.md): ${t.summary}`).join("\n")}`);
  if (guides?.length) sections.push(`## Guides\n\n${guides.map((g) => `- [${g.namespace}/${g.name}](${SITE_URL}/guides/${g.namespace}/${g.name}.md): ${g.title ? `${g.title}. ` : ""}${g.summary}`).join("\n")}`);
  sections.push(`## otlite tools\n\notlite installs these with pip or git into per-tool virtualenvs on Linux and macOS, no Docker (${SITE_URL}/otlite). Each page says what the tool takes, the exact command it receives and its caveats.\n\n${OTLITE_TOOLS.map((t) => `- [${t.display_name}](${SITE_URL}${toolPath(t.name)}.md): ${firstSentence(t.description)}`).join("\n")}`);
  if (publishers?.length) sections.push(`## Publishers\n\n${publishers.slice(0, 50).map((p) => `- [${p.display_name}](${SITE_URL}/${p.name}.md): ${p.packages} ${p.packages === 1 ? "package" : "packages"}${p.verified ? ", verified publisher" : ""}`).join("\n")}`);
  sections.push(
    [
      "## Optional",
      "",
      `- [Full docs](${SITE_URL}/llms-full.txt): every docs and policy page in one file`,
    ].join("\n"),
  );
  // A copy missing the API sections is kept only briefly.
  return new Response(`${sections.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": cacheControl(tools && guides ? 3600 : 300) },
  });
};
