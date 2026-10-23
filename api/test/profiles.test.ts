// Publisher profiles: syncing from GitHub and GitLab, overrides, About, pins, privacy, activity, sync triggers and
// secondary hosts.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshDueProfiles, syncProfile } from "../src/profiles";
import { social, webUrl, avatarUrl } from "../src/hosts/profiles";
import { encrypt, sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, profileSent, testEnv, webhook } from "./helpers";

const DB = () => env.DB;
const GH = "https://api.github.com";
const GL = "https://gitlab.com/api/v4";
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

beforeEach(() => void (profileSent.length = 0));

/** A signed-in user; optionally an owner of namespaces and with linked GitHub or GitLab accounts. */
async function user(opts: { owns?: string[]; github?: string; gitlab?: string } = {}) {
  const id = ulid();
  const token = `ot_test_${id}`;
  const login = `u${uniq()}`;
  const stmts = [
    DB().prepare(`INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)`).bind(id, login, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
    ...(opts.owns ?? []).map((ns) => DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(ns, id)),
  ];
  for (const p of ["github", "gitlab"] as const) {
    const providerId = opts[p];
    if (!providerId) continue;
    stmts.push(DB().prepare(
      `INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(), id, p, providerId, `${login}-${p}`, await encrypt(env.TOKEN_ENC_KEY, `${p}-token`), Date.now() + 3600_000, Date.now()));
  }
  await DB().batch(stmts);
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function namespace(over: { provider?: string; kind?: string; status?: string; owner?: string } = {}) {
  const id = ulid();
  const name = `p${uniq()}`;
  const owner = over.owner ?? uniq();
  await DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, over.provider ?? "github", owner, name, over.kind ?? "user", over.status ?? "active", name, Date.now()).run();
  return { id, name, owner };
}

const ghUser = (id: string, login: string, over: Record<string, unknown> = {}) => ({
  id: Number(id), login, type: "User", name: "Dee Example", bio: "I build OSINT tools.", location: "Leeds", blog: "example.org",
  company: "@acme", twitter_username: "dee_osint", email: "private@example.com", avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  created_at: "2015-03-04T00:00:00Z", ...over,
});

/** GitHub as the seeded dheeraj (user 1001) and osintverse (org 1002) see it. */
function seededHosts(extra: Parameters<typeof fakeHosts>[0] = {}) {
  return fakeHosts({
    [`GET ${GH}/user/1001`]: ghUser("1001", "dheeraj"),
    [`GET ${GH}/users/dheeraj/social_accounts`]: [
      { provider: "mastodon", url: "https://infosec.exchange/@dheeraj" },
      { provider: "linkedin", url: "https://www.linkedin.com/in/dheeraj" },
      { provider: "generic", url: "javascript:alert(1)" },
    ],
    [`GET ${GH}/user/1002`]: { id: 1002, login: "osintverse", type: "Organization", avatar_url: "https://avatars.githubusercontent.com/u/1002?v=4", created_at: "2020-01-01T00:00:00Z" },
    [`GET ${GH}/orgs/osintverse`]: { login: "osintverse", name: "OSINTverse", description: "Open-source intelligence tools.", blog: "https://osintverse.com", location: "Internet", email: "org@example.com" },
    [`GET ${GH}/orgs/osintverse/public_members`]: [
      { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
      { login: "bob", avatar_url: "https://evil.example.com/a.png" },
    ],
    ...extra,
  });
}

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await call(path, { headers });
  return { res, body: (await res.json()) as any };
};

describe("host profile parsing", () => {
  it("keeps only safe URLs and allowed avatar hosts", () => {
    expect(webUrl("example.org")).toBe("https://example.org/");
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("https://user:pw@example.org")).toBeNull();
    expect(avatarUrl("https://avatars.githubusercontent.com/u/1")).toBe("https://avatars.githubusercontent.com/u/1");
    expect(avatarUrl("https://evil.example.com/a.png")).toBeNull();
    expect(avatarUrl("http://gitlab.com/uploads/a.png")).toBeNull();
    expect(social("https://twitter.com/x")?.provider).toBe("x");
    expect(social("https://infosec.exchange/@dee")?.provider).toBe("mastodon");
    expect(social("https://example.org/me")?.provider).toBe("other");
  });
});

describe("syncing from GitHub", () => {
  it("copies a user's public profile, never the email, and the page shows it", async () => {
    seededHosts();
    expect(await syncProfile(await testEnv(), "ns_dheeraj")).toEqual({ status: "ok" });
    const { res, body } = await get("/namespaces/dheeraj");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body.display_name).toBe("Dee Example");
    expect(body.avatar_url).toBe("https://avatars.githubusercontent.com/u/1001?v=4");
    expect(body.profile).toMatchObject({ bio: "I build OSINT tools.", location: "Leeds", website: "https://example.org/", company: "@acme", details_hidden: false });
    expect(body.profile.socials.map((s: any) => s.provider).sort()).toEqual(["linkedin", "mastodon", "x"]);
    expect(body.profile.hosts).toEqual([{ provider: "github", login: "dheeraj", url: "https://github.com/dheeraj", primary: true }]);
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(body.stats.packages).toBe(body.tools.length);
    expect(body.stats.tools + body.stats.guides).toBe(body.stats.packages);
    expect(body.tools[0].published_at).toEqual(expect.any(Number));
    const p = await DB().prepare(`SELECT sync_status, synced_at FROM namespace_profiles WHERE namespace_id = 'ns_dheeraj'`).first<any>();
    expect(p.sync_status).toBe("ok");
  });

  it("uses an org's description and lists its public members", async () => {
    seededHosts();
    await syncProfile(await testEnv(), "ns_osintverse");
    const { body } = await get("/namespaces/osintverse");
    expect(body.display_name).toBe("OSINTverse");
    expect(body.profile.bio).toBe("Open-source intelligence tools.");
    expect(body.profile.members).toEqual([
      { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", url: "https://github.com/alice" },
      { login: "bob", avatar_url: null, url: "https://github.com/bob" },
    ]);
    expect(JSON.stringify(body)).not.toContain("org@example.com");
  });

  it("records a failure and keeps the last good values", async () => {
    seededHosts();
    await syncProfile(await testEnv(), "ns_dheeraj");
    fakeHosts({ [`GET ${GH}/user/1001`]: new Response("boom", { status: 502 }) });
    const r = await syncProfile(await testEnv(), "ns_dheeraj");
    expect(r.status).toBe("error");
    const p = await DB().prepare(`SELECT sync_status, sync_error, host_bio FROM namespace_profiles WHERE namespace_id = 'ns_dheeraj'`).first<any>();
    expect(p).toMatchObject({ sync_status: "error", host_bio: "I build OSINT tools." });
    expect(p.sync_error).toContain("502");
  });
});

describe("syncing from GitLab", () => {
  it("reads a public group and its members", async () => {
    const ns = await namespace({ provider: "gitlab", kind: "group", owner: "77" });
    fakeHosts({
      [`GET ${GL}/groups/77`]: { id: 77, full_path: "acme/osint", name: "Acme OSINT", description: "Group tools", visibility: "public", avatar_url: "https://gitlab.com/uploads/-/system/group/avatar/77/a.png" },
      [`GET ${GL}/groups/77/members`]: [{ username: "carol", avatar_url: "https://secure.gravatar.com/avatar/x", state: "active" }, { username: "gone", state: "blocked" }],
    });
    await syncProfile(await testEnv(), ns.id);
    const p = await DB().prepare(`SELECT host_login, host_url, host_name, host_bio, host_members_json FROM namespace_profiles WHERE namespace_id = ?`).bind(ns.id).first<any>();
    expect(p).toMatchObject({ host_login: "acme/osint", host_url: "https://gitlab.com/acme/osint", host_name: "Acme OSINT", host_bio: "Group tools" });
    expect(JSON.parse(p.host_members_json)).toEqual([{ login: "carol", avatar_url: "https://secure.gravatar.com/avatar/x", url: "https://gitlab.com/carol" }]);
  });

  it("reads a user's social fields", async () => {
    const ns = await namespace({ provider: "gitlab", owner: "88" });
    fakeHosts({
      [`GET ${GL}/users/88`]: { id: 88, username: "dee", name: "Dee", bio: "hi", website_url: "https://dee.example", organization: "Acme", twitter: "dee", linkedin: "dee-li", mastodon: "@dee@infosec.exchange", public_email: "dee@example.com" },
    });
    await syncProfile(await testEnv(), ns.id);
    const p = await DB().prepare(`SELECT host_socials_json, host_company FROM namespace_profiles WHERE namespace_id = ?`).bind(ns.id).first<any>();
    expect(JSON.parse(p.host_socials_json)).toEqual([
      { provider: "x", url: "https://x.com/dee" },
      { provider: "linkedin", url: "https://www.linkedin.com/in/dee-li" },
      { provider: "mastodon", url: "https://infosec.exchange/@dee" },
    ]);
    expect(p.host_company).toBe("Acme");
  });
});

describe("owner settings", () => {
  it("lets owners override fields until they clear them, and sync never overwrites an override", async () => {
    const owner = await user({ owns: ["ns_dheeraj"] });
    seededHosts();
    await syncProfile(await testEnv(), "ns_dheeraj");
    let res = await call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ custom: { bio: "Written by me", website: "", socials: ["https://bsky.app/profile/dee.example"] } }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const view = (await res.json()) as any;
    expect(view.custom).toEqual({ bio: "Written by me", website: "", socials: [{ provider: "bluesky", url: "https://bsky.app/profile/dee.example" }] });
    expect(view.host.bio).toBe("I build OSINT tools.");
    await syncProfile(await testEnv(), "ns_dheeraj");
    let { body } = await get("/namespaces/dheeraj");
    expect(body.profile).toMatchObject({ bio: "Written by me", website: null, socials: [{ provider: "bluesky", url: "https://bsky.app/profile/dee.example" }] });
    res = await call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ custom: { bio: null, website: null, socials: null } }) });
    expect(res.status).toBe(200);
    ({ body } = await get("/namespaces/dheeraj"));
    expect(body.profile.bio).toBe("I build OSINT tools.");
    expect(body.profile.website).toBe("https://example.org/");
  });

  it("refuses bad values", async () => {
    const owner = await user({ owns: ["ns_dheeraj"] });
    for (const custom of [{ website: "javascript:alert(1)" }, { avatar_url: "https://evil.example.com/a.png" }, { socials: "nope" }, { email: "x@example.com" }]) {
      const res = await call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ custom }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("invalid_body");
    }
  });

  it("hides host details when asked, keeping the name and hosts", async () => {
    const owner = await user({ owns: ["ns_osintverse"] });
    seededHosts();
    await syncProfile(await testEnv(), "ns_osintverse");
    await call("/me/namespaces/osintverse/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ hide_details: true }) });
    const { body } = await get("/namespaces/osintverse");
    expect(body.display_name).toBe("OSINTverse");
    expect(body.profile).toMatchObject({ bio: null, location: null, website: null, socials: [], members: [], details_hidden: true, host_since: null });
    expect(body.profile.hosts).toHaveLength(1);
  });

  it("renders the About section without raw HTML or images, and previews it", async () => {
    const owner = await user({ owns: ["ns_dheeraj"] });
    const md = "# About us\n\nWe **build** tools. <script>alert(1)</script>\n\n![logo](logo.png) [site](https://example.org) [tool](whois-lite)";
    const preview = await call("/me/namespaces/dheeraj/profile/preview", { method: "POST", headers: owner.auth, body: JSON.stringify({ about: md }) });
    const p = (await preview.json()) as any;
    expect(p.html).toContain("<strong>build</strong>");
    expect(p.html).not.toContain("<script");
    expect(p.html).not.toContain("<img");
    expect(p.html).toContain('href="https://otinstaller.com/dheeraj/whois-lite"');
    expect(p.problems.map((x: any) => x.code)).toContain("content_raw_html");
    await call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ about: md }) });
    const { body } = await get("/namespaces/dheeraj");
    expect(body.profile.about_html).toBe(p.html);
    await call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ about: null }) });
    expect((await get("/namespaces/dheeraj")).body.profile.about_html).toBeNull();
  });

  it("pins up to six of the namespace's own packages", async () => {
    const owner = await user({ owns: ["ns_dheeraj"] });
    const pin = (pins: unknown) => call("/me/namespaces/dheeraj/profile", { method: "PATCH", headers: owner.auth, body: JSON.stringify({ pins }) });
    expect((await pin(["whois-lite", "sherlock"])).status).toBe(400);
    expect((await pin(["a", "b", "c", "d", "e", "f", "g"])).status).toBe(400);
    expect((await pin(["whois-lite", "whois-lite"])).status).toBe(200);
    const { body } = await get("/namespaces/dheeraj");
    expect(body.profile.pins).toEqual(["whois-lite"]);
  });

  it("is for owners only", async () => {
    const stranger = await user();
    expect((await call("/me/namespaces/dheeraj/profile", { headers: stranger.auth })).status).toBe(403);
    expect((await call("/me/namespaces/dheeraj/profile")).status).toBe(401);
    const owner = await user({ owns: ["ns_dheeraj"] });
    const res = await call("/me/namespaces/dheeraj/profile", { headers: owner.auth });
    const view = (await res.json()) as any;
    expect(view.fields).toContain("bio");
    expect(view.packages.map((p: any) => p.name)).toContain("whois-lite");
  });

  it("rate-limits manual syncs", async () => {
    const ns = await namespace();
    const owner = await user({ owns: [ns.id] });
    fakeHosts({ [`GET ${GH}/user/${ns.owner}`]: ghUser(ns.owner, ns.name), [`GET ${GH}/users/${ns.name}/social_accounts`]: [] });
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await call(`/me/namespaces/${ns.name}/profile/sync`, { method: "POST", headers: owner.auth });
    expect(last!.status).toBe(429);
    expect(((await last!.json()) as any).error.code).toBe("profile_sync_rate_limited");
    const view = (await (await call(`/me/namespaces/${ns.name}/profile`, { headers: owner.auth })).json()) as any;
    expect(view.sync.status).toBe("ok");
    expect(view.effective.display_name).toBe("Dee Example");
  });
});

describe("namespaces waiting for review", () => {
  it("show only the handle and host, never what the owner wrote", async () => {
    await DB().prepare(`INSERT INTO namespace_profiles (namespace_id, about_html, host_bio, custom_json, updated_at) VALUES ('ns_newbie', '<p>spam</p>', 'bio', '{"display_name":"Official Google"}', ?)
      ON CONFLICT (namespace_id) DO UPDATE SET about_html = excluded.about_html, custom_json = excluded.custom_json`).bind(Date.now()).run();
    const { res, body } = await get("/namespaces/newbie");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ name: "newbie", status: "pending_review", display_name: "newbie", tools: [], verified: false });
    expect(body.profile).toMatchObject({ about_html: null, bio: null, pins: [] });
    expect(JSON.stringify(body)).not.toContain("Official Google");
    expect((await get("/namespaces/newbie/activity")).body.events).toEqual([]);
  });

  it("rejected and unknown namespaces are not found", async () => {
    const ns = await namespace({ status: "rejected" });
    expect((await get(`/namespaces/${ns.name}`)).res.status).toBe(404);
    expect((await get("/namespaces/no-such-ns")).res.status).toBe(404);
  });
});

describe("activity", () => {
  it("lists public events only", async () => {
    const v = await DB().prepare(`SELECT id FROM versions WHERE tool_id = 'tool_dheeraj_whois-lite' LIMIT 1`).first<{ id: string }>();
    const t0 = Date.now();
    const row = (action: string, kind: string, target: string, meta: unknown, at: number) =>
      DB().prepare(`INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, metadata_json, created_at) VALUES (?, NULL, 'system', ?, ?, ?, ?, ?)`)
        .bind(ulid(), action, kind, target, JSON.stringify(meta), at);
    await DB().batch([
      row("version.published", "version", v!.id, { ref: "dheeraj/whois-lite" }, t0 + 1),
      row("version.yank", "version", v!.id, { reason: "private note" }, t0 + 2),
      row("tool.deprecate", "tool", "tool_dheeraj_whois-lite", { message: "x" }, t0 + 3),
      row("report.create", "tool", "tool_dheeraj_whois-lite", { reason: "malware" }, t0 + 4),
      row("token.write", "token", "tok", {}, t0 + 5),
    ]);
    const { body } = await get("/namespaces/dheeraj/activity?limit=3");
    expect(body.events.map((e: any) => e.type)).toEqual(["deprecated", "yanked", "published"]);
    expect(body.events[1]).toMatchObject({ ref: "dheeraj/whois-lite", kind: "tool", version: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("private note");
    expect(JSON.stringify(body)).not.toContain("malware");
  });

  it("lists the registry's public events, filtered and paged, without reasons or hidden packages", async () => {
    const t0 = Date.now() + 10_000;
    const ver = (toolId: string) => DB().prepare(`SELECT id FROM versions WHERE tool_id = ? ORDER BY created_at LIMIT 1`).bind(toolId).first<{ id: string }>();
    const holehe = await ver("tool_dheeraj_holehe-lite");
    // A package nobody can see yet: its namespace is waiting for review.
    const pending = await namespace({ status: "pending_review" });
    const hiddenTool = ulid();
    const hiddenVersion = ulid();
    await DB().batch([
      DB().prepare(`INSERT INTO tools (id, namespace_id, name, summary, categories, latest_version_id, created_at, updated_at) VALUES (?, ?, 'secret-tool', 'Hidden', '[]', ?, 0, 0)`).bind(hiddenTool, pending.id, hiddenVersion),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.0.0', 1, 0, 0, '{}', 'published', 1, 0)`).bind(hiddenVersion, hiddenTool),
    ]);
    const row = (action: string, kind: string, target: string, meta: unknown, at: number) =>
      DB().prepare(`INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, metadata_json, created_at) VALUES (?, NULL, 'system', ?, ?, ?, ?, ?)`)
        .bind(ulid(), action, kind, target, JSON.stringify(meta), at);
    await DB().batch([
      row("version.published", "version", holehe!.id, {}, t0 + 1),
      row("version.published", "version", hiddenVersion, {}, t0 + 2),
      row("version.yank", "version", holehe!.id, { reason: "private yank note" }, t0 + 3),
      row("tool.deprecated_archived", "tool", "tool_dheeraj_holehe-lite", {}, t0 + 4),
      row("report.create", "tool", "tool_dheeraj_holehe-lite", { reason: "malware" }, t0 + 5),
      row("version.remove", "version", holehe!.id, { reason: "takedown details" }, t0 + 6),
    ]);

    const { res, body } = await get("/activity?limit=3");
    expect(res.headers.get("cache-control")).toMatch(/public.*max-age=300/);
    expect(body.events.map((e: any) => [e.type, e.ref])).toEqual([
      ["deprecated", "dheeraj/holehe-lite"], ["yanked", "dheeraj/holehe-lite"], ["published", "dheeraj/holehe-lite"],
    ]);
    expect(body.events[2]).toMatchObject({ kind: "tool", version: expect.any(String), new_package: expect.any(Boolean), has_notes: false, summary: expect.any(String) });
    expect(body.next_before).toBe(t0 + 1);
    const text = JSON.stringify(body);
    for (const secret of ["private yank note", "malware", "takedown details", "secret-tool"]) expect(text).not.toContain(secret);

    // The next page starts after the last event; filters narrow by kind and input type.
    const older = (await get(`/activity?limit=3&before=${body.next_before}`)).body;
    expect(older.events.every((e: any) => e.at < t0 + 1)).toBe(true);
    expect((await get("/activity?kind=guide&limit=5")).body.events.every((e: any) => e.kind === "guide")).toBe(true);
    const byInput = (await get("/activity?input=email&limit=5")).body.events;
    expect(byInput.length).toBeGreaterThan(0);
    expect((await get("/activity?input=crypto_address&limit=5")).body.events.some((e: any) => e.ref === "dheeraj/holehe-lite")).toBe(false);

    const mine = (await get("/activity?namespace=dheeraj&limit=10")).body.events;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: any) => e.ref.startsWith("dheeraj/"))).toBe(true);
    expect((await get(`/activity?namespace=${pending.name}`)).body.events).toEqual([]);

    expect((await get("/activity?before=yesterday")).res.status).toBe(400);
    expect((await get("/activity?namespace=Not_A_Name")).res.status).toBe(400);
    expect((await get("/activity?kind=plugin")).res.status).toBe(400);
  });
});

describe("keeping profiles in sync", () => {
  it("queues a refresh on GitHub organization events", async () => {
    const res = await webhook("organization", { action: "member_added", organization: { id: 1002, login: "osintverse" }, sender: { id: 5 } });
    expect(((await res.json()) as any).status).toBe("profile refresh queued");
    expect(profileSent).toContainEqual({ profileNamespaceId: "ns_osintverse" });
  });

  it("queues a first sync when the GitHub App creates a namespace", async () => {
    await webhook("installation", {
      action: "created", installation: { id: Number(uniq()), account: { id: Number(uniq()), login: `new${uniq()}`, type: "User" }, repository_selection: "all" },
      repositories: [], sender: { id: 1 },
    });
    expect(profileSent.some((m: any) => typeof m.profileNamespaceId === "string")).toBe(true);
  });

  it("the cron syncs profiles that were never synced or are stale, and leaves fresh ones", async () => {
    const fresh = await namespace();
    const stale = await namespace();
    await DB().batch([
      DB().prepare(`UPDATE namespace_profiles SET synced_at = ? `).bind(Date.now()),
      DB().prepare(`INSERT INTO namespace_profiles (namespace_id, synced_at, sync_status, updated_at) VALUES (?, ?, 'ok', ?)`).bind(fresh.id, Date.now(), Date.now()),
      DB().prepare(`INSERT INTO namespace_profiles (namespace_id, synced_at, sync_status, updated_at) VALUES (?, ?, 'ok', ?)`).bind(stale.id, Date.now() - 7 * 3600_000, Date.now()),
    ]);
    const calls = fakeHosts({ [`GET ${GH}/user/`]: (req) => ghUser(req.url.split("/").pop()!, "someone") });
    await refreshDueProfiles(await testEnv(), Date.now(), 100);
    expect(calls.some((c) => c.url === `${GH}/user/${stale.owner}`)).toBe(true);
    expect(calls.some((c) => c.url === `${GH}/user/${fresh.owner}`)).toBe(false);
    const p = await DB().prepare(`SELECT host_name FROM namespace_profiles WHERE namespace_id = ?`).bind(stale.id).first<any>();
    expect(p.host_name).toBe("Dee Example");
  });
});

describe("secondary hosts", () => {
  it("links the owner's own GitLab account to a GitHub namespace, and unlinks it", async () => {
    const owner = await user({ owns: ["ns_dheeraj"], gitlab: "4242" });
    seededHosts({ [`GET ${GL}/users/4242`]: { id: 4242, username: "dee-gl", name: "Dee on GitLab", location: "York" } });
    const res = await call("/me/namespaces/dheeraj/profile/hosts", { method: "POST", headers: owner.auth, body: JSON.stringify({ provider: "gitlab" }) });
    expect(res.status).toBe(201);
    const view = (await res.json()) as any;
    expect(view.hosts).toEqual([
      { provider: "github", login: "dheeraj", url: "https://github.com/dheeraj", primary: true },
      { provider: "gitlab", login: "dee-gl", url: "https://gitlab.com/dee-gl", primary: false },
    ]);
    // The primary host's values win; the secondary only fills gaps.
    expect(view.host.location).toBe("Leeds");
    const again = await call("/me/namespaces/dheeraj/profile/hosts", { method: "POST", headers: owner.auth, body: JSON.stringify({ provider: "github" }) });
    expect(((await again.json()) as any).error.code).toBe("host_already_primary");
    const del = await call("/me/namespaces/dheeraj/profile/hosts/gitlab", { method: "DELETE", headers: owner.auth });
    expect(((await del.json()) as any).hosts).toHaveLength(1);
  });

  it("needs the host account linked first", async () => {
    const owner = await user({ owns: ["ns_dheeraj"] });
    const res = await call("/me/namespaces/dheeraj/profile/hosts", { method: "POST", headers: owner.auth, body: JSON.stringify({ provider: "gitlab" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("host_account_not_linked");
  });

  it("links a GitHub org the owner administers to a registry namespace, and refuses one they don't", async () => {
    const ns = await namespace({ provider: "registry", kind: "org" });
    const owner = await user({ owns: [ns.id], github: "555" });
    fakeHosts({
      [`GET ${GH}/orgs/acme`]: { id: 9001, login: "acme" },
      [`GET ${GH}/user/memberships/orgs/acme`]: { state: "active", role: "admin" },
      [`GET ${GH}/orgs/other`]: { id: 9002, login: "other" },
      [`GET ${GH}/user/memberships/orgs/other`]: { state: "active", role: "member" },
      [`GET ${GH}/user/9001`]: { id: 9001, login: "acme", type: "Organization", avatar_url: "https://avatars.githubusercontent.com/u/9001" },
      [`GET ${GH}/orgs/acme/public_members`]: [],
    });
    const ok = await call(`/me/namespaces/${ns.name}/profile/hosts`, { method: "POST", headers: owner.auth, body: JSON.stringify({ provider: "github", account: "acme" }) });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).hosts).toEqual([{ provider: "github", login: "acme", url: "https://github.com/acme", primary: false }]);
    const { body } = await get(`/namespaces/${ns.name}`);
    expect(body.avatar_url).toBe("https://avatars.githubusercontent.com/u/9001");
    const no = await call(`/me/namespaces/${ns.name}/profile/hosts`, { method: "POST", headers: owner.auth, body: JSON.stringify({ provider: "github", account: "other" }) });
    expect(no.status).toBe(403);
    expect(((await no.json()) as any).error.code).toBe("host_not_owned");
  });
});

describe("publisher list", () => {
  it("lists namespaces with visible packages", async () => {
    const { res, body } = await get("/namespaces");
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
    const names = body.namespaces.map((x: any) => x.name);
    expect(names).toContain("dheeraj");
    expect(names).not.toContain("newbie");
  });
});
