import { describe, expect, it } from "vitest";
import { exampleRun, formatCount, guidePageHref, inputLabel } from "./format";
import { withParam } from "./page";

describe("format", () => {
  it("builds the example run line from required inputs only", () => {
    expect(exampleRun("dheeraj/holehe-lite", [
      { name: "email", type: "email", required: true },
      { name: "timeout", type: "integer", required: false },
    ])).toBe("ot run dheeraj/holehe-lite --email <email>");
  });

  it("links guide pages without .md, pinning old versions only", () => {
    expect(guidePageHref("alice/playbook", "sub/02-pivot.md")).toBe("/guides/alice/playbook/sub/02-pivot");
    expect(guidePageHref("alice/playbook", "index.md", "1.0.0")).toBe("/guides/alice/playbook/index?v=1.0.0");
  });

  it("labels inputs and shortens counts", () => {
    expect(inputLabel("crypto_address")).toBe("Crypto address");
    expect(inputLabel("new_type")).toBe("new type");
    expect([formatCount(999), formatCount(1234), formatCount(56789)]).toEqual(["999", "1.2k", "57k"]);
  });

  it("changes one filter and starts results from the top", () => {
    const url = new URL("https://otinstaller.com/search?q=email&input=email&cursor=24");
    expect(withParam(url, "runtime", "docker")).toBe("/search?q=email&input=email&runtime=docker");
    expect(withParam(url, "input", null)).toBe("/search?q=email");
  });
});
