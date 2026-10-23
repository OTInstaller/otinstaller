import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("are all names the API never gives a namespace (api/src/lib/reserved.ts)", () => {
    const api = readFileSync(fileURLToPath(new URL("../../../api/src/lib/reserved.ts", import.meta.url)), "utf8");
    const names = new Set([...api.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
    expect([...RESERVED].filter((n) => !names.has(n))).toEqual([]);
  });
});
