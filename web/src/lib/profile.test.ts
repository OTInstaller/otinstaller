import { describe, expect, it } from "vitest";
import type { Namespace, ToolSummary } from "./api";
import { aboutHtml, activityText, profileMarkdown, profileQuery, publisherEntity, socialLabel, sortPackages } from "./profile";

const tool = (name: string, over: Partial<ToolSummary & { published_at: number }> = {}) => ({
  namespace: "acme", name, kind: "tool" as const, summary: `${name} does things.`, latest_version: "1.0.0", categories: [], inputs: ["domain"], outputs: [],
  runtime: "docker" as const, stars: 0, installs_30d: 0, health: "healthy" as const, verified: true, signed: true, needs_keys: false,
  manifest_held_by_registry: false, community_packaged: false, source_unavailable: false, status: "active", published_at: 0, ...over,
});

const ns = (over: Partial<Namespace> = {}): Namespace => ({
  name: "acme", kind: "org", provider: "github", status: "active", display_name: "Acme OSINT", avatar_url: "https://avatars.githubusercontent.com/u/1",
  verified: true, created_at: Date.UTC(2026, 0, 2),
  profile: {
    bio: "We build tools.", location: "Leeds", website: "https://acme.example/", company: null,
    socials: [{ provider: "mastodon", url: "https://infosec.exchange/@acme" }, { provider: "other", url: "https://www.blog.example/me" }],
    members: [{ login: "alice", avatar_url: null, url: "https://github.com/alice" }],
    hosts: [{ provider: "github", login: "acme", url: "https://github.com/acme", primary: true }, { provider: "gitlab", login: "acme-gl", url: "https://gitlab.com/acme-gl", primary: false }],
    about_html: "<h2>What we do</h2><p>Domain &amp; DNS tools.</p>", pins: ["dns"], details_hidden: false, host_since: null,
  },
  stats: { packages: 2, tools: 1, guides: 1, installs_30d: 1200, installs_total: 5000, stars: 3, healthy: 1, broken: 0, last_published_at: Date.UTC(2026, 9, 1) },
  tools: [tool("dns", { installs_30d: 1200 }), tool("osint-101", { kind: "guide", title: "OSINT 101" })],
  ...over,
});

describe("profileQuery", () => {
  it("falls back to the defaults for unknown values", () => {
    expect(profileQuery(new URL("https://x/acme?tab=evil&sort=installs&kind=guide"))).toEqual({ tab: "packages", sort: "installs", kind: "guide" });
    expect(profileQuery(new URL("https://x/acme?tab=activity&sort=name"))).toEqual({ tab: "activity", sort: "name", kind: "all" });
  });
});

describe("sortPackages", () => {
  const list = [tool("b", { installs_30d: 5, published_at: 3 }), tool("a", { installs_30d: 5, stars: 2, published_at: 1 }), tool("c", { installs_30d: 9, published_at: 2 })];
  it("sorts by installs, then stars, then name", () => expect(sortPackages(list, "installs").map((t) => t.name)).toEqual(["c", "a", "b"]));
  it("sorts by the latest release", () => expect(sortPackages(list, "updated").map((t) => t.name)).toEqual(["b", "c", "a"]));
  it("sorts by name", () => expect(sortPackages(list, "name").map((t) => t.name)).toEqual(["a", "b", "c"]));
});

describe("labels", () => {
  it("names social networks and falls back to the host", () => {
    expect(socialLabel({ provider: "x", url: "https://x.com/a" })).toBe("X");
    expect(socialLabel({ provider: "other", url: "https://www.blog.example/me" })).toBe("blog.example");
  });
  it("describes activity", () => {
    expect(activityText({ type: "published", ref: "acme/dns", kind: "tool", at: 0, version: "1.2.0" })).toBe("Published acme/dns v1.2.0");
    expect(activityText({ type: "transferred", ref: "acme/dns", kind: "tool", at: 0, from: "old/dns", to: "acme/dns" })).toBe("Received acme/dns from old/dns");
  });
});

describe("publisherEntity", () => {
  it("describes an org with its links and members", () => {
    expect(publisherEntity(ns())).toMatchObject({
      "@type": "Organization", name: "Acme OSINT", alternateName: "acme", description: "We build tools.", location: { "@type": "Place", name: "Leeds" },
      sameAs: ["https://github.com/acme", "https://gitlab.com/acme-gl", "https://acme.example/", "https://infosec.exchange/@acme", "https://www.blog.example/me"],
      member: [{ "@type": "Person", name: "alice", url: "https://github.com/alice" }],
    });
  });
  it("describes a user as a Person", () => {
    const e = publisherEntity(ns({ kind: "user" }));
    expect(e["@type"]).toBe("Person");
    expect(e.homeLocation).toEqual({ "@type": "Place", name: "Leeds" });
  });
});

describe("profileMarkdown", () => {
  it("lists who it is, stats, About as text, pins, tools and guides", () => {
    const md = profileMarkdown(ns(), [{ type: "published", ref: "acme/dns", kind: "tool", at: Date.UTC(2026, 9, 1), version: "1.0.0" }]);
    expect(md).toContain("# Acme OSINT (acme)");
    expect(md).toContain("- On GitHub: [acme](https://github.com/acme)");
    expect(md).toContain("- On GitLab: [acme-gl](https://gitlab.com/acme-gl)");
    expect(md).toContain("- Installs: 1.2k in the last 30 days, 5.0k in all");
    expect(md).toContain("## About\n\nWhat we do\n\nDomain & DNS tools.");
    expect(md).toContain("## Pinned\n\n- [acme/dns](https://otinstaller.com/acme/dns.md)");
    expect(md).toContain("- [OSINT 101](https://otinstaller.com/guides/acme/osint-101.md)");
    expect(md).toContain("Published acme/dns v1.0.0");
    expect(md).not.toContain("<");
    expect(profileMarkdown(ns({ profile: { ...ns().profile!, about_html: "<p>&lt;script&gt;x&lt;/script&gt;</p>" } }))).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(md).toContain("dns does things. Install with");
  });
  it("says a pending publisher is waiting for review", () => {
    const md = profileMarkdown(ns({ status: "pending_review", tools: [], stats: undefined }));
    expect(md).toContain("waiting for review");
    expect(md).not.toContain("has not published anything");
  });
});

describe("aboutHtml", () => {
  it("moves headings under the About heading", () => {
    expect(aboutHtml('<h1 id="a">A</h1><h2>B</h2><p>x</p>')).toBe('<h3 id="a">A</h3><h4>B</h4><p>x</p>');
    expect(aboutHtml("<h5>A</h5>")).toBe("<h5>A</h5>");
    expect(aboutHtml("<p>x</p>")).toBe("<p>x</p>");
  });
});
