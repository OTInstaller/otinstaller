import { describe, expect, it } from "vitest";
import { ethicsBlock, inputsBlock, problemKey, scalar, setTopLevel, topLevelBlock } from "./yaml-blocks";

const draft = `schema: 1
name: holehe
namespace: alice
summary: Checks whether an email is registered on sites
inputs:
  - name: email
    type: email
    required: true
runtime:
  kind: docker
  command: [holehe, "{email}"]
`;

describe("yaml blocks", () => {
  it("finds a top-level block", () => {
    expect(topLevelBlock(draft, "inputs")).toEqual({ start: 4, end: 8 });
    expect(topLevelBlock(draft, "ethics")).toBeNull();
  });
  it("replaces a block in place and appends a missing one", () => {
    const out = setTopLevel(draft, "inputs", inputsBlock([{ name: "username", type: "username", required: true, description: "The handle" }]));
    expect(out).toContain("inputs:\n  - name: username\n    type: username\n    required: true\n    description: The handle\nruntime:");
    expect(out).not.toContain("name: email");
    const withEthics = setTopLevel(out, "ethics", ethicsBlock({ touches_target: false, auth_required: false, collects_personal_data: true }));
    expect(withEthics.endsWith("ethics:\n  touches_target: false\n  auth_required: false\n  collects_personal_data: true\n")).toBe(true);
  });
  it("quotes scalars YAML would misread", () => {
    expect(scalar("holehe")).toBe("holehe");
    expect(scalar("yes")).toBe('"yes"');
    expect(scalar("1.2.3")).toBe('"1.2.3"');
    expect(scalar("a: b")).toBe('"a: b"');
  });
  it("maps a problem path to its key", () => {
    expect(problemKey("/inputs/0/type")).toBe("inputs");
    expect(problemKey("/name")).toBe("name");
    expect(problemKey(undefined)).toBeNull();
  });
});
