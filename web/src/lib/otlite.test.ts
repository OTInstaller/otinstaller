import { describe, expect, it } from "vitest";
import { markdownPage, renderMarkdown } from "./markdown";
import { OTLITE_PAGES, OTLITE_TOOLS, batchUse, findOtliteTool, firstSentence, notices, otherNotes, pin, pythonRange, relatedTools } from "./otlite";
import { runLine, shellQuote, toolArgs } from "./otlite-args";

describe("toolArgs", () => {
  it("passes a value with no flag as a positional argument", () => expect(toolArgs([], [{ flag: "", value: "johndoe" }])).toEqual(["johndoe"]));
  it("puts a flag before the value", () => expect(toolArgs([], [{ flag: "--domain", value: "example.com" }])).toEqual(["--domain", "example.com"]));
  it("splits a subcommand and its flag", () =>
    expect(toolArgs(["--no-banner"], [{ flag: "harvest-emails --domain", value: "example.com" }])).toEqual(["--no-banner", "harvest-emails", "--domain", "example.com"]));
});

describe("shell quoting", () => {
  it("leaves safe words bare", () => expect(shellQuote("ada@example.com")).toBe("ada@example.com"));
  it("quotes spaces and quotes", () => {
    expect(shellQuote("john doe")).toBe("'john doe'");
    expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`);
  });
  it("quotes the whole typed input", () => expect(runLine("sherlock", [{ prefix: "u", value: "john doe" }])).toBe("otlite run sherlock -- 'u:john doe'"));
});

// The page's builder must give what otlite itself gives: the catalog's tool_args come from otlite's own code.
describe("the builder matches otlite", () => {
  for (const t of OTLITE_TOOLS) {
    for (const entry of t.inputs) {
      it(`${t.name} ${entry.parts.map((p) => p.prefix).join("+")}`, () => {
        const parts = entry.parts.map((p) => ({ prefix: p.prefix, flag: p.flag, value: p.sample }));
        expect(toolArgs(t.default_args, parts)).toEqual(entry.tool_args);
        expect(runLine(t.name, parts)).toBe(entry.command);
      });
    }
  }
});

describe("tool pages", () => {
  const sherlock = findOtliteTool("sherlock")!;

  it("finds tools by name only", () => {
    expect(sherlock.display_name).toBe("Sherlock");
    expect(findOtliteTool("nope")).toBeUndefined();
  });

  it("links the pinned release or commit", () => {
    expect(pin(sherlock).url).toMatch(/^https:\/\/pypi\.org\/project\/[^/]+\/[^/]+\/$/);
    const git = OTLITE_TOOLS.find((t) => t.install.method === "git")!;
    expect(pin(git).url).toMatch(/^https:\/\/github\.com\/.+\/tree\/[0-9a-f]{40}$/);
    expect(pin(git).short).toMatch(/^git [0-9a-f]{7}$/);
  });

  it("says Python ranges in words", () => {
    expect(pythonRange("<3.13")).toBe("older than 3.13");
    expect(pythonRange(">=3.12")).toBe("3.12 or newer");
  });

  it("keeps the first sentence", () => {
    expect(firstSentence("Find accounts. Then more.")).toBe("Find accounts");
    expect(firstSentence("Version 2.0 finds accounts")).toBe("Version 2.0 finds accounts");
  });

  it("warns before interactive and setup-heavy tools", () => {
    const ghunt = findOtliteTool("ghunt")!;
    const titles = notices(ghunt).map((n) => n.title);
    expect(titles).toContain("Asks questions while it runs.");
    expect(titles).toContain("Needs Python older than 3.14.");
    expect(batchUse(ghunt).skip).toMatch(/asks questions/);
    expect(notices(sherlock)).toEqual([]);
    expect(batchUse(sherlock)).toEqual({ all: "otlite run --all u:johndoe", auto: "otlite auto johndoe", skip: null });
  });

  it("relates tools that take the same things, never itself", () => {
    const related = relatedTools(sherlock);
    expect(related.length).toBeGreaterThan(0);
    expect(related.length).toBeLessThanOrEqual(6);
    expect(related.map((r) => r.name)).not.toContain("sherlock");
    for (const r of related) expect(r.accepts.some((a) => sherlock.accepts.includes(a))).toBe(true);
  });
});

describe("Markdown twins", () => {
  it("has one per tool at its page's path and .md URL", () => {
    expect(OTLITE_PAGES).toHaveLength(OTLITE_TOOLS.length);
    expect(markdownPage("/otlite/tools/sherlock")?.title).toBe("Sherlock (otlite)");
    expect(markdownPage("/otlite/tools/sherlock.md")?.slug).toBe("sherlock");
    expect(markdownPage("/otlite/tools/nope")).toBeNull();
  });

  it("uses absolute links only and carries the run commands and notes", () => {
    for (const page of OTLITE_PAGES) {
      const md = renderMarkdown(page);
      expect(md, page.slug).not.toMatch(/\]\(\/(?!\/)/);
      const t = findOtliteTool(page.slug)!;
      for (const e of t.inputs) expect(md).toContain(e.command);
      for (const n of otherNotes(t)) expect(md).toContain(n);
      expect(md).not.toContain("NOASSERTION");
    }
  });

  it("folds the reason for a Python range into its caution instead of repeating it", () => {
    const ghunt = findOtliteTool("ghunt")!;
    const python = notices(ghunt).find((n) => n.title.startsWith("Needs Python"))!;
    expect(python.text).toMatch(/^Its dependency Pillow 10/);
    expect(otherNotes(ghunt).some((n) => n.startsWith("Needs Python"))).toBe(false);
    expect(otherNotes(ghunt)).toHaveLength(ghunt.notes.length - 1);
  });
});
