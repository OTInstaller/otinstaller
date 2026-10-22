import { describe, expect, it } from "vitest";
import { upstreamOf } from "../src/publish";
import type { Manifest } from "../src/lib/manifest";

const wrapper = (homepage: unknown, namespace = "osintverse-community") => ({ namespace, name: "checkdmarc", homepage }) as unknown as Manifest;

describe("community wrapper provenance", () => {
  it("names the upstream repository of a community wrapper", () => {
    expect(upstreamOf({ repo: "osintverse-community/checkdmarc" }, wrapper("https://github.com/domainaware/checkdmarc"))).toBe("github.com/domainaware/checkdmarc");
    expect(upstreamOf({ repo: "osintverse-community/x" }, wrapper("https://gitlab.com/group/sub/project"))).toBe("gitlab.com/group/sub/project");
  });

  // publish.ts uses this to set tools.community_packaged, so a first-party tool in the namespace is never labelled a wrapper.
  it("is only for community wrappers that point elsewhere", () => {
    expect(upstreamOf({ repo: "someone/checkdmarc" }, wrapper("https://github.com/domainaware/checkdmarc", "someone"))).toBeUndefined();
    expect(upstreamOf({ repo: "osintverse-community/checkdmarc" }, wrapper("https://github.com/osintverse-community/checkdmarc"))).toBeUndefined();
    expect(upstreamOf({ repo: "osintverse-community/checkdmarc" }, wrapper("https://example.com"))).toBeUndefined();
    expect(upstreamOf({ repo: "osintverse-community/checkdmarc" }, wrapper(undefined))).toBeUndefined();
  });
});
