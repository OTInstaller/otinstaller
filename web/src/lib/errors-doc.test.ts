import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every API error links to /docs/errors#<code>, so every code the API can send needs a heading on that page.
// Codes are found by the same literal calls the API uses: apiError(status, "code"), refuse(...), fail(...) and
// `code: "x"` in hand-built envelopes and problem lists.
const apiSrc = fileURLToPath(new URL("../../../api/src", import.meta.url));
const errorsDoc = fileURLToPath(new URL("../pages/docs/errors.md", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function apiCodes(): string[] {
  const codes = new Set<string>();
  for (const file of tsFiles(apiSrc)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:apiError|refuse|fail)\(\s*\d+,\s*"([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of src.matchAll(/\bcode: "([a-z_]+)"/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

describe("docs/errors.md", () => {
  it("has a heading for every code the API can send", () => {
    const doc = readFileSync(errorsDoc, "utf8");
    const headings = new Set([...doc.matchAll(/^### ([a-z_]+)$/gm)].map((m) => m[1]));
    const missing = apiCodes().filter((c) => !headings.has(c));
    expect(missing).toEqual([]);
  });

  it("has no duplicate headings", () => {
    const doc = readFileSync(errorsDoc, "utf8");
    const all = [...doc.matchAll(/^### ([a-z_]+)$/gm)].map((m) => m[1]);
    expect(all.filter((c, i) => all.indexOf(c) !== i)).toEqual([]);
  });
});
