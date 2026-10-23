import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import reserved from "../../../spec/reserved-namespaces.json";

// A registry namespace named like one of the site's own top-level pages would have its publisher page hidden by it,
// so the API refuses every name the middleware keeps for itself (spec/reserved-namespaces.json).
const middleware = fileURLToPath(new URL("../middleware.ts", import.meta.url));

describe("reserved namespace names", () => {
  it("include every top-level page the site keeps for itself", () => {
    const src = readFileSync(middleware, "utf8");
    const set = /const RESERVED = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(set).not.toBeNull();
    const site = [...set![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(site.length).toBeGreaterThan(10);
    expect(site.filter((name) => !reserved.names.includes(name))).toEqual([]);
  });
});
