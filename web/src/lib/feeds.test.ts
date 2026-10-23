import { describe, expect, it } from "vitest";
import { atom, eventEntry, feedLinks, jsonFeed, versionEntries, type Feed } from "./feeds";
import type { RegistryEvent, Version } from "./api";

const event = (over: Partial<RegistryEvent> = {}): RegistryEvent => ({
  id: "01ABC", type: "published", ref: "dheeraj/holehe-lite", kind: "tool", summary: "Checks <sites> & more", at: Date.UTC(2026, 9, 20, 12), version: "1.2.0", ...over,
});

describe("feed entries", () => {
  it("titles events from fields and links release notes when there are any", () => {
    expect(eventEntry(event({ new_package: true }))).toMatchObject({ id: "tag:otinstaller.com,2026:01ABC", title: "New tool: dheeraj/holehe-lite", url: "/dheeraj/holehe-lite" });
    expect(eventEntry(event({ has_notes: true }))).toMatchObject({ title: "dheeraj/holehe-lite 1.2.0 released", url: "/dheeraj/holehe-lite/versions#v1.2.0" });
    expect(eventEntry(event({ type: "deprecated", version: undefined, replacement: "x/y" })).title).toBe("dheeraj/holehe-lite deprecated: use x/y");
    expect(eventEntry(event({ type: "transferred", version: undefined, to: "acme" })).title).toBe("dheeraj/holehe-lite moved to acme");
    expect(eventEntry(event({ kind: "guide", new_package: true, ref: "a/email-guide" }))).toMatchObject({ title: "New guide: a/email-guide", url: "/guides/a/email-guide" });
  });

  it("turns versions into entries with their notes, leaving removed ones out", () => {
    const v = (version: string, over: Partial<Version> = {}): Version => ({ version, status: "published", scan_status: "pass", published_at: 1, yanked_at: null, signed: true, ...over });
    const entries = versionEntries({ namespace: "a", name: "b", summary: "S" }, [v("2.0.0", { changelog_html: "<p>new</p>" }), v("1.1.0", { status: "yanked" }), v("1.0.0", { status: "removed" })]);
    expect(entries.map((e) => [e.title, e.html, e.summary])).toEqual([["a/b 2.0.0", "<p>new</p>", undefined], ["a/b 1.1.0 (yanked)", undefined, "S"]]);
  });

  it("offers the registry feed on every page and the page's own after it", () => {
    expect(feedLinks().map((l) => l.href)).toEqual(["/feed.atom", "/feed.json"]);
    expect(feedLinks({ title: "x", path: "/a/feed" }).map((l) => [l.href, l.type])).toEqual([
      ["/feed.atom", "application/atom+xml"], ["/feed.json", "application/feed+json"], ["/a/feed.atom", "application/atom+xml"], ["/a/feed.json", "application/feed+json"],
    ]);
  });
});

describe("feed formats", () => {
  const feed: Feed = {
    title: "T & co", description: "D", home: "/new", path: "/feed",
    entries: [{ ...eventEntry(event()), html: '<p>a <a href="https://x">b</a></p>\u0001' }],
  };

  it("writes Atom with everything escaped", () => {
    const xml = atom(feed);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(xml).toContain("<title>T &amp; co</title>");
    expect(xml).toContain("<summary>Checks &lt;sites&gt; &amp; more</summary>");
    expect(xml).toContain('<content type="html">&lt;p&gt;a &lt;a href=&quot;https://x&quot;&gt;b&lt;/a&gt;&lt;/p&gt;</content>');
    expect(xml).toContain("<updated>2026-10-20T12:00:00.000Z</updated>");
    expect(xml).toMatch(/<link rel="self" type="application\/atom\+xml" href="https?:\/\/[^"]+\/feed\.atom"\/>/);
    expect(xml).not.toContain("\u0001");
  });

  it("writes JSON Feed 1.1 with the required fields", () => {
    const j = jsonFeed(feed) as any;
    expect(j.version).toBe("https://jsonfeed.org/version/1.1");
    expect(j.feed_url).toMatch(/\/feed\.json$/);
    expect(j.items[0]).toMatchObject({ id: "tag:otinstaller.com,2026:01ABC", title: "dheeraj/holehe-lite 1.2.0 released", content_html: expect.stringContaining("<p>a"), summary: "Checks <sites> & more" });
    expect(j.items[0].url).toMatch(/^https?:\/\//);
  });
});
