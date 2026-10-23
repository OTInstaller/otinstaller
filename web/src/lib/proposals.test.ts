import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isWrapper, PROPOSAL_FILES, PROPOSAL_STATUS_LABEL, PROPOSAL_STATUS_TONE } from "./proposals";

// The API's lists are the source; every status needs words on the site, and the files must be the same.
const src = readFileSync(fileURLToPath(new URL("../../../api/src/proposals.ts", import.meta.url)), "utf8");
const list = (name: string) => {
  const line = src.split(/\r?\n/).find((l) => l.startsWith(`export const ${name} = [`));
  if (!line) throw new Error(`${name} not found in api/src/proposals.ts`);
  return [...line.matchAll(/"([A-Za-z_.]+)"/g)].map((m) => m[1]!);
};

describe("change proposal labels", () => {
  it("words every status the API knows and offers the files it takes", () => {
    for (const s of list("PROPOSAL_STATUSES")) expect([PROPOSAL_STATUS_LABEL[s as keyof typeof PROPOSAL_STATUS_LABEL], PROPOSAL_STATUS_TONE[s as keyof typeof PROPOSAL_STATUS_TONE]].every(Boolean)).toBe(true);
    expect(PROPOSAL_FILES).toEqual(list("PROPOSAL_FILES"));
  });

  it("knows a community wrapper from a package published from its own repository", () => {
    expect(isWrapper({ community_packaged: true, homepage: "https://github.com/up/tool", repo_url: "https://github.com/osintverse-community/tool" })).toBe(true);
    expect(isWrapper({ community_packaged: true, homepage: "https://github.com/osintverse-community/tool", repo_url: "https://github.com/osintverse-community/tool" })).toBe(false);
    expect(isWrapper({ community_packaged: false, homepage: "https://github.com/up/tool", repo_url: "https://github.com/me/tool" })).toBe(false);
  });
});
