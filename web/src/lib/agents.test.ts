import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENTS_PAGE, CLIENTS, CONSENT, PLUGIN, PROMPTS, READ_ONLY_TOOLS, REMOTE_MCP, REMOTE_TOOLS, RULES, SIDE_EFFECT_TOOLS, inline } from "./agents";
import { markdownPage, renderMarkdown } from "./markdown";

const doc = (name: string) => readFileSync(fileURLToPath(new URL(`../pages/docs/${name}.md`, import.meta.url)), "utf8");

// The /agents page (and its Markdown twin) and the docs it summarises must say the same thing.
describe("agents page content", () => {
  it("uses the commands and consent classes of docs/agents.md", () => {
    const agents = doc("agents");
    for (const c of CLIENTS) expect(agents).toContain(`\`${c.command}\``);
    for (const cmd of PLUGIN) expect(agents).toContain(cmd);
    for (const c of CONSENT) expect(agents).toContain(`| ${c.name} |`);
    for (const r of RULES) expect(agents).toContain(`- ${r}`);
  });

  it("names only tools and prompts that docs/mcp-tools.md describes", () => {
    const tools = doc("mcp-tools");
    for (const name of [...READ_ONLY_TOOLS, ...SIDE_EFFECT_TOOLS, ...PROMPTS, ...REMOTE_TOOLS]) expect(tools).toContain(`| \`${name}\` |`);
  });
});

describe("agents Markdown twin", () => {
  it("is found at /agents and /agents.md", () => {
    expect(markdownPage("/agents")).toBe(AGENTS_PAGE);
    expect(markdownPage("/agents.md")).toBe(AGENTS_PAGE);
    expect(markdownPage("/agents/")).toBe(AGENTS_PAGE);
  });

  it("has the title, the remote server, every rule and only absolute links", () => {
    const md = renderMarkdown(AGENTS_PAGE);
    expect(md.startsWith("# OTInstaller for AI agents\n\n")).toBe(true);
    expect(md).toContain(REMOTE_MCP);
    for (const r of RULES) expect(md).toContain(r.replace("](/", "](https://otinstaller.com/"));
    expect(md).not.toMatch(/\]\(\/(?!\/)/);
  });
});

describe("inline", () => {
  it("splits code spans and links from plain text", () => {
    expect(inline("Cite by `run_id`, see [the policy](/policy/acceptable-use).")).toEqual([
      { kind: "text", text: "Cite by " },
      { kind: "code", text: "run_id" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "the policy", href: "/policy/acceptable-use" },
      { kind: "text", text: "." },
    ]);
    expect(inline("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});
