import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDES_NS, LEARN_LINKS, LEARN_PAGE } from "./learn";
import { DOC_PAGES, markdownPage, POLICY_PAGES } from "./markdown";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const schema = JSON.parse(readFileSync(repo("spec/schema/v1.json"), "utf8"));
const inputs: string[] = schema.$defs.inputType.enum;
// Site pages that are not docs, policy or guide pages.
const SITE = new Set(["/tour", "/agents", "/otlite"]);

describe("learn page links", () => {
  it.each(LEARN_LINKS.map((l) => [l.href, l.label]))("%s exists", (href) => {
    const guide = new RegExp(`^/guides/${GUIDES_NS}/([a-z0-9-]+)(?:/([a-z0-9-]+))?$`).exec(href);
    if (guide) {
      const dir = repo(`seed/guides/${guide[1]}`);
      expect(existsSync(`${dir}/otinstaller.yaml`)).toBe(true);
      if (guide[2]) expect(readFileSync(`${dir}/otinstaller.yaml`, "utf8")).toContain(`- ${guide[2]}.md`);
    } else if (href.startsWith("/docs/")) {
      expect(DOC_PAGES.some((p) => p.path === href)).toBe(true);
    } else if (href.startsWith("/policy/")) {
      expect(POLICY_PAGES.some((p) => p.path === href)).toBe(true);
    } else if (href.startsWith("/input/")) {
      expect(inputs).toContain(href.slice("/input/".length));
    } else {
      expect(SITE.has(href)).toBe(true);
    }
  });

  it("serves the same content as Markdown", () => {
    expect(markdownPage("/learn")).toBe(LEARN_PAGE);
    expect(markdownPage("/learn.md")).toBe(LEARN_PAGE);
    for (const l of LEARN_LINKS) expect(LEARN_PAGE.body).toContain(`](${l.href})`);
  });
});
