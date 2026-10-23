import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESERVED, SLUG } from "./twins";

// A top-level page whose name could also be a namespace must be reserved, or the middleware would answer its
// Markdown twin (/<page>.md, or Accept: text/markdown) with a publisher's profile.
describe("reserved first path segments", () => {
  it("lists every top-level page that looks like a namespace", () => {
    const names = readdirSync(new URL("../pages", import.meta.url))
      .map((f) => f.replace(/(\.md)?\.(astro|ts)$/, ""))
      .filter((n) => n !== "index" && !n.startsWith("[") && SLUG.test(n));
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !RESERVED.has(n))).toEqual([]);
  });
});
