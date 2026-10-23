import { describe, expect, it } from "vitest";
import type { ToolSummary } from "./api";
import { breadcrumbs, clip, faqFromMarkdown, faqPage, graph, itemList, softwareApplication } from "./seo";

describe("softwareApplication", () => {
  it("is free, absolute and leaves out what is unknown", () => {
    const app = softwareApplication({ name: "Ghunt", description: "Offensive Google framework", path: "/otlite/tools/ghunt", operatingSystem: "Linux, macOS", version: "2.3.4", license: "NOASSERTION", repository: "https://github.com/mxrch/GHunt" });
    expect(app.url).toBe("https://otinstaller.com/otlite/tools/ghunt");
    expect(app.softwareVersion).toBe("2.3.4");
    expect(app.codeRepository).toBe("https://github.com/mxrch/GHunt");
    expect(app).not.toHaveProperty("license");
    expect(app).not.toHaveProperty("keywords");
    expect(app.isAccessibleForFree).toBe(true);
  });
});

describe("faqFromMarkdown", () => {
  it("pairs question headings with their answers, links and code flattened", () => {
    const md = "Intro\n\n## Is it free?\n\nYes. See [the docs](/docs) and `ot run`.\n\n## Notes\n\nNot a question.\n\n## Do I need Docker?\n\nFor Docker tools,\nyes.\n";
    expect(faqFromMarkdown(md)).toEqual([
      ["Is it free?", "Yes. See the docs and ot run."],
      ["Do I need Docker?", "For Docker tools, yes."],
    ]);
  });
});

describe("clip", () => {
  it("keeps short text", () => expect(clip("Finds accounts", 60)).toBe("Finds accounts"));
  it("cuts at a word and drops trailing punctuation", () => {
    expect(clip("Finds accounts by username across 400+ social networks and websites", 40)).toBe("Finds accounts by username across 400+…");
  });
});

describe("JSON-LD builders", () => {
  it("number breadcrumb positions from 1 with absolute URLs", () => {
    const b = breadcrumbs([["Tools", "/search"], ["osintverse-community", "/osintverse-community"], ["sherlock", "/osintverse-community/sherlock"]]);
    const items = b.itemListElement as { position: number; item: string }[];
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[0]!.item).toBe("https://otinstaller.com/search");
  });
  it("lists tools and guides at their own addresses", () => {
    const base: Omit<ToolSummary, "namespace" | "name"> = { kind: "tool", summary: "", latest_version: "1", categories: [], inputs: [], outputs: [], runtime: null, stars: 0, installs_30d: 0, health: "unknown", verified: false, signed: true, needs_keys: false, manifest_held_by_registry: false, community_packaged: false, source_unavailable: false, status: "published" };
    const list = itemList("Email tools", [
      { ...base, namespace: "ns", name: "holehe" },
      { ...base, namespace: "ns", name: "email-investigation", kind: "guide", title: "Email playbook" },
    ]);
    const items = list.itemListElement as { url: string; name: string }[];
    expect(items[0]!.url).toBe("https://otinstaller.com/ns/holehe");
    expect(items[1]).toMatchObject({ url: "https://otinstaller.com/guides/ns/email-investigation", name: "Email playbook" });
    expect(list.numberOfItems).toBe(2);
  });
  it("wraps nodes in a graph with the schema.org context", () => {
    const g = graph({ "@type": "WebSite" }, faqPage([["Q?", "A."]]));
    expect(g["@context"]).toBe("https://schema.org");
    expect((g["@graph"] as unknown[]).length).toBe(2);
  });
});
