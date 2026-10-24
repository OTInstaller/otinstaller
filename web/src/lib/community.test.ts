import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guessPlatform, KIND_HELP, KIND_LABEL, STATUS_LABEL, STATUS_TONE } from "./community";
import { REPORT_CHOICES } from "./report";

// The API's lists of kinds and statuses are the source; every one needs words on the site.
const src = readFileSync(fileURLToPath(new URL("../../../api/src/community.ts", import.meta.url)), "utf8");
/** The string values of an exported array of the API's community module, e.g. ISSUE_KINDS. */
function list(name: string): string[] {
  const line = src.split(/\r?\n/).find((l) => l.startsWith(`export const ${name} = [`));
  if (!line) throw new Error(`${name} not found in api/src/community.ts`);
  return [...line.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("community labels", () => {
  it("words every issue kind and status the API knows", () => {
    for (const k of list("ISSUE_KINDS")) expect([KIND_LABEL[k as keyof typeof KIND_LABEL], KIND_HELP[k as keyof typeof KIND_HELP]].every(Boolean)).toBe(true);
    for (const s of list("ISSUE_STATUSES")) expect([STATUS_LABEL[s as keyof typeof STATUS_LABEL], STATUS_TONE[s as keyof typeof STATUS_TONE]].every(Boolean)).toBe(true);
  });

  it("offers every problem the API counts without a sign-in, and files only issue kinds it knows", () => {
    for (const k of list("PROBLEM_KINDS")) expect(REPORT_CHOICES.some((c) => c.counts === k)).toBe(true);
    for (const c of REPORT_CHOICES) if (c.issue) expect(list("ISSUE_KINDS")).toContain(c.issue);
  });

  it("guesses the platform as ot reports it, and leaves Macs' chip alone", () => {
    expect(guessPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("windows/amd64");
    expect(guessPlatform("Mozilla/5.0 (X11; Linux aarch64) Firefox/131")).toBe("linux/arm64");
    expect(guessPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605")).toBe("darwin");
    expect(guessPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("");
  });
});
