import { describe, expect, it } from "vitest";
import { demoteHeadings, textOf } from "./html";

describe("demoteHeadings", () => {
  it("moves every heading down one level and keeps attributes", () => {
    expect(demoteHeadings('<h1 id="a">A</h1><p>x</p><h2 id="b">B</h2><h5>E</h5><h6>F</h6>')).toBe('<h2 id="a">A</h2><p>x</p><h3 id="b">B</h3><h6>E</h6><h6>F</h6>');
  });
  it("drops a leading h1 that repeats the page title and keeps the other levels", () => {
    expect(demoteHeadings('<h1 id="t">Email <em>investigation</em> playbook</h1>\n<p>Lead</p><h2>Step 1</h2>', "Email investigation playbook")).toBe("<p>Lead</p><h2>Step 1</h2>");
  });
  it("still demotes when another h1 follows the dropped one", () => {
    expect(demoteHeadings("<h1>Title</h1><h1>Again</h1><h2>B</h2>", "Title")).toBe("<h2>Again</h2><h3>B</h3>");
  });
  it("keeps a leading h1 that says something else", () => {
    expect(demoteHeadings("<h1>sherlock (community package)</h1><p>x</p>", "sherlock")).toBe("<h2>sherlock (community package)</h2><p>x</p>");
  });
  it("leaves text without an h1 alone", () => {
    expect(demoteHeadings("<p>only a paragraph</p><h2>B</h2>")).toBe("<p>only a paragraph</p><h2>B</h2>");
  });
});

describe("textOf", () => {
  it("strips tags and decodes common entities", () => {
    expect(textOf("<b>A &amp; B</b>  <i>&quot;c&quot;</i>")).toBe('A & B "c"');
  });
});
