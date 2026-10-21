// Tests for the Markdown twins of tool and guide pages.
import { describe, expect, it } from "vitest";
import type { Manifest, Page, ToolDetail } from "./api";
import { consent, guidePageMarkdown, mcpCall, problemMarkdown, runLines, toolMarkdown } from "./tool-markdown";

function detail(manifest: Partial<Manifest>, extra: Partial<ToolDetail> = {}): ToolDetail {
  return {
    namespace: "acme", name: "finder", kind: "tool", summary: "Finds accounts for a username", latest_version: "1.2.0",
    categories: ["username"], inputs: [], outputs: [], runtime: "docker", stars: 0, installs_30d: 42, health: "healthy",
    verified: true, signed: true, needs_keys: false, manifest_held_by_registry: false, community_packaged: false,
    source_unavailable: false, status: "active", repo_url: "https://github.com/acme/finder", homepage: null, license: "MIT",
    manifest: {
      name: "finder", namespace: "acme", version: "1.2.0", summary: "Finds accounts for a username", license: "MIT", categories: ["username"],
      readme: "README.md", inputs: [], outputs: [{ type: "account" }], ...manifest,
    },
    ...extra,
  };
}

describe("runLines", () => {
  it("uses a typed prefix per input type, with flags for the other required inputs", () => {
    const m = detail({
      inputs: [
        { name: "username", type: "username", required: true },
        { name: "site", type: "domain", required: false },
        { name: "limit", type: "integer", required: true, default: 5 },
      ],
      test: { input: { username: "alice" } },
    }).manifest;
    expect(runLines("acme/finder", m)).toEqual(["ot run acme/finder u:alice --limit 5", "ot run acme/finder d:example.com --username alice --limit 5"]);
  });

  it("falls back to flags when no input has a prefix, or several share one", () => {
    expect(runLines("acme/x", detail({ inputs: [{ name: "hash", type: "hash", required: true }] }).manifest)).toEqual(["ot run acme/x --hash d41d8cd98f00b204e9800998ecf8427e"]);
    const two = detail({ inputs: [{ name: "from", type: "email", required: true }, { name: "to", type: "email", required: true }] }).manifest;
    expect(runLines("acme/x", two)).toEqual(["ot run acme/x --from jane@example.com --to jane@example.com"]);
    expect(runLines("acme/x", detail({ inputs: [{ name: "q", type: "string", required: true, description: "x" }], test: { input: { q: "two words" } } }).manifest)).toEqual(['ot run acme/x --q "two words"']);
  });

  it("builds the MCP call from the required inputs", () => {
    const m = detail({ inputs: [{ name: "username", type: "username", required: true }, { name: "limit", type: "integer", required: false }] }).manifest;
    expect(mcpCall("acme/finder", m)).toBe('run_tool {"tool":"acme/finder","inputs":{"username":"johndoe"}}');
  });
});

describe("consent", () => {
  const offline = { touches_target: false, auth_required: false, collects_personal_data: false };
  it("is not needed for a passive tool", () => {
    const c = consent(detail({ inputs: [{ name: "domain", type: "domain", required: true }], ethics: offline, network: { egress: false } }).manifest);
    expect(c.needed).toBe(false);
    expect(c.text).toContain("https://otinstaller.com/docs/agents#consent");
  });
  it("is needed when the tool touches the target, goes online, collects personal data or takes a person's identifier", () => {
    expect(consent(detail({ ethics: { ...offline, touches_target: true } }).manifest).text).toContain("contacts the target");
    expect(consent(detail({ ethics: offline, network: { egress: true } }).manifest).text).toContain("goes online");
    expect(consent(detail({ ethics: { ...offline, collects_personal_data: true } }).manifest).text).toContain("personal data");
    expect(consent(detail({ ethics: offline, inputs: [{ name: "email", type: "email", required: true }] }).manifest).needed).toBe(true);
    expect(consent(detail({}).manifest).needed).toBe(true); // no ethics block: treated as touching the target
  });
});

describe("toolMarkdown", () => {
  const t = detail({
    inputs: [{ name: "username", type: "username", required: true, description: "The handle | without @" }],
    ethics: { touches_target: true, auth_required: true, collects_personal_data: false },
    network: { egress: true, domains: ["api.example.com"] },
    secrets: [{ name: "EXAMPLE_API_KEY", required: true, description: "API key for Example", url: "https://example.com/keys" }],
    docs: { root: "docs/", nav: ["index.md"] },
  });
  const md = toolMarkdown(t);

  it("has the sections in order", () => {
    const order = ["# acme/finder\n\nFinds accounts for a username", "ot install acme/finder", "ot run acme/finder u:johndoe", "run_tool {", "## Inputs", "## Outputs", "## What a run does", "## API keys", "## Trust", "## Links"];
    const at = order.map((s) => md.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("describes the run, the keys, trust and links", () => {
    expect(md).toContain("| `username` | username | yes |  | The handle \\| without @ |");
    expect(md).toContain("Finds: account.");
    expect(md).toContain("Contacts the target directly");
    expect(md).toContain("Needs an account");
    expect(md).toContain("Connects to api.example.com.");
    expect(md).toContain("needs the person's consent");
    expect(md).toContain("- `EXAMPLE_API_KEY` (required): API key for Example Get one at https://example.com/keys");
    expect(md).toContain("- Installs in the last 30 days: 42");
    expect(md).toContain("- Signed: yes");
    expect(md).toContain("- Web page: https://otinstaller.com/acme/finder");
    expect(md).toContain("- JSON: https://api.otinstaller.com/v1/tools/acme/finder");
    expect(md).toContain("- Docs: https://otinstaller.com/acme/finder/docs");
    expect(md).toContain("- README: https://github.com/acme/finder#readme");
  });

  it("says when a tool runs offline and has no keys", () => {
    const off = toolMarkdown(detail({ ethics: { touches_target: false, auth_required: false, collects_personal_data: false }, network: { egress: false } }));
    expect(off).toContain("Runs offline");
    expect(off).toContain("can run it without asking");
    expect(off).not.toContain("## API keys");
  });

  it("points a guide to its pages", () => {
    const g = toolMarkdown(detail({ content: { root: "docs/", nav: ["index.md", "01-start.md"] } }, { kind: "guide", name: "howto", title: "How to" }));
    expect(g).toContain("This is a guide");
    expect(g).toContain("https://otinstaller.com/guides/acme/howto.md");
    expect(g).toContain("- https://otinstaller.com/guides/acme/howto/01-start.md");
    expect(g).not.toContain("ot install");
  });

  it("has short bodies for missing and removed packages", () => {
    expect(problemMarkdown(404, "acme/nope")).toContain("# Not found");
    expect(problemMarkdown(410, "acme/gone", "acme/gone was removed (other) on 2026-10-21")).toBe("# Removed\n\nacme/gone was removed (other) on 2026-10-21.\n");
    expect(problemMarkdown(410, "acme/gone")).toContain("acme/gone was removed from the registry.");
  });
});

describe("guidePageMarkdown", () => {
  const page: Page = {
    ref: "acme/howto", version: "1.0.0", path: "index.md", title: "How to", position: 1, pages: 2,
    body: "# How to\n\nStart with [the first step](01-start.md#scope) or [the site](https://example.com).\n", toc: [],
    prev: null, next: { path: "01-start.md", title: "Start" },
  };
  it("adds the title, source and next page, and makes page links absolute twins", () => {
    const md = guidePageMarkdown(page);
    expect(md.startsWith("# How to\n\nSource: https://otinstaller.com/guides/acme/howto/index (page 1 of 2 of acme/howto)\n\nStart with")).toBe(true);
    expect(md).toContain("[the first step](https://otinstaller.com/guides/acme/howto/01-start.md#scope)");
    expect(md).toContain("[the site](https://example.com)");
    expect(md.trim().endsWith("Next: https://otinstaller.com/guides/acme/howto/01-start.md")).toBe(true);
  });
  it("keeps a pinned version in the links", () => {
    expect(guidePageMarkdown({ ...page, next: null }, "0.9.0")).toContain("01-start.md?v=0.9.0#scope");
  });
});
