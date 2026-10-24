import { describe, expect, it } from "vitest";
import { REPORT_CHOICES, reportChoice, reportHref, withError } from "./report";

describe("report choices", () => {
  it("takes only its own keys from ?kind=", () => {
    expect(reportChoice("outdated")).toMatchObject({ issue: "outdated", counts: "outdated" });
    expect(reportChoice("error")).toMatchObject({ issue: "broken", counts: "broken" });
    expect(reportChoice("abuse")).toMatchObject({ issue: null, counts: null });
    for (const k of ["toString", "constructor", "__proto__", "", "feature", null, undefined]) expect(reportChoice(k)).toBeNull();
  });

  it("counts without a sign-in only what can be said without words", () => {
    expect(REPORT_CHOICES.filter((c) => c.counts).map((c) => c.key)).toEqual(["broken", "error", "outdated"]);
  });

  it("links to the report page with the choice and the version encoded", () => {
    expect(reportHref("dheeraj/holehe-lite")).toBe("/dheeraj/holehe-lite/report");
    expect(reportHref("dheeraj/holehe-lite", { kind: "abuse" })).toBe("/dheeraj/holehe-lite/report?kind=abuse");
    expect(reportHref("dheeraj/holehe-lite", { kind: "broken", version: "1.2.0-rc.1+x/y" })).toBe("/dheeraj/holehe-lite/report?kind=broken&v=1.2.0-rc.1%2Bx%2Fy");
  });
});

describe("error messages in an issue", () => {
  it("adds the error as a code block under its own heading", () => {
    expect(withError("It stops at once.", "  \n")).toBe("It stops at once.");
    expect(withError("It stops at once.\n", "\nKeyError: 'data'\n  at line 3\n")).toBe("It stops at once.\n\n**Error**\n\n```\nKeyError: 'data'\n  at line 3\n```");
    expect(withError("", "Traceback")).toBe("**Error**\n\n```\nTraceback\n```");
  });

  it("uses a fence the message can't close", () => {
    expect(withError("", "a ``` b ```` c")).toBe("**Error**\n\n`````\na ``` b ```` c\n`````");
  });
});
