// Tests for the Markdown twins: Accept negotiation and the bundled pages.
import { describe, expect, it } from "vitest";
import { DOC_PAGES, POLICY_PAGES, markdownPage, prefersMarkdown, renderMarkdown } from "./markdown";

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/markdown, text/html", true],
    ["text/html, text/markdown", false],
    ["text/html;q=0.5, text/markdown", true],
    ["text/markdown;q=0", false],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
    ["*/*", false],
    ["", false],
  ])("%s → %s", (accept, want) => expect(prefersMarkdown(accept)).toBe(want));
});

describe("pages", () => {
  it("finds docs and policy pages by path", () => {
    expect(markdownPage("/docs")?.slug).toBe("index");
    expect(markdownPage("/docs/index.md")?.slug).toBe("index");
    expect(markdownPage("/docs/cli/")?.title).toBe("CLI reference");
    expect(markdownPage("/policy/terms.md")?.section).toBe("policy");
    expect(markdownPage("/policy/transparency")).toBeNull();
    expect(markdownPage("/search")).toBeNull();
  });

  it("strips frontmatter and adds the title and description", () => {
    const md = renderMarkdown(markdownPage("/docs/cli")!);
    expect(md.startsWith("# CLI reference\n\nEvery ot command and its options.\n\n")).toBe(true);
    expect(md).not.toContain("layout:");
    expect(renderMarkdown(markdownPage("/docs")!)).toContain("](https://otinstaller.com/docs/getting-started)");
    expect(DOC_PAGES[0].path).toBe("/docs");
    expect(POLICY_PAGES[0].slug).toBe("acceptable-use");
  });
});
