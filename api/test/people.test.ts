// Contributor profiles: the counts the nightly refresh keeps, recent issues and requests, what a profile never shows,
// hiding a profile, and when one is worth indexing.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { refreshContributorStats } from "../src/people";
import { requiredScope } from "../src/scopes";
import { call } from "./helpers";

const DB = () => env.DB;
const TOOL = "dheeraj/holehe-lite";
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

type Who = { id: string; handle: string; headers: Record<string, string> };

async function person(opts: { reviewer?: boolean } = {}): Promise<Who> {
  const id = ulid();
  const handle = `c${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, handle, email, avatar_url, is_reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, handle, handle, `${handle}@mail.example.net`, `https://avatars.example/${handle}.png`, opts.reviewer ? 1 : 0, Date.now() - 30 * 86_400_000),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { id, handle, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function req(who: Who | null, method: string, path: string, body?: unknown) {
  const res = await call(path, { method, headers: who?.headers ?? {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return { res, body: (await res.json().catch(() => null)) as any };
}

describe("contributor profiles", () => {
  it("shows what someone did, recounted nightly, and never their email", async () => {
    const alice = await person();
    const issue = await req(alice, "POST", `/tools/${TOOL}/issues`, { kind: "broken", title: `Fails on every address ${uniq()}`, body: "It exits with 1 straight away on 1.2.0.", version: "1.2.0" });
    expect(issue.res.status).toBe(201);
    const bob = await person();
    await req(bob, "POST", `/tools/${TOOL}/issues/${issue.body.number}/comments`, { body: "Same here on macOS." });
    await req(bob, "PUT", `/tools/${TOOL}/confirmations`, { result: "broken", version: "1.2.0", platform: "darwin/arm64" });
    await DB().prepare(
      `INSERT INTO tool_requests (id, number, provider, repo_path, repo_key, url, requested_by, status, vote_count, created_at, updated_at)
       SELECT ?, COALESCE(MAX(number), 0) + 1, 'github', ?, ?, ?, ?, 'published', 1, ?, ? FROM tool_requests`,
    ).bind(ulid(), `x/t${uniq()}`, `github:x/t${uniq()}`, "https://github.com/x/t", bob.id, Date.now(), Date.now()).run();

    await refreshContributorStats(env as any);
    const a = await req(null, "GET", `/people/${alice.handle}`);
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get("cache-control")).toMatch(/public/);
    expect(a.body).toMatchObject({ handle: alice.handle, roles: [], counts: { issues_opened: 1, issues_confirmed: 0, replies: 0 }, indexable: false });
    expect(a.body.issues[0]).toMatchObject({ ref: TOOL, number: issue.body.number, kind: "broken", status: "open" });
    expect(JSON.stringify(a.body)).not.toContain("mail.example.net");
    expect(a.body).not.toHaveProperty("login");

    const b = await req(null, "GET", `/people/${bob.handle.toUpperCase()}`);
    expect(b.body.counts).toMatchObject({ replies: 1, confirmations: 1, requests_made: 1, requests_published: 1 });
    expect(b.body.indexable).toBe(true);
    expect(b.body.requests).toHaveLength(1);

    // A triager confirming alice's report makes it count, and the triager's closing counts for them.
    const staff = await person({ reviewer: true });
    await req(staff, "POST", `/tools/${TOOL}/issues/${issue.body.number}/status`, { status: "fixed", fixed_in: "1.2.1" });
    await refreshContributorStats(env as any);
    expect((await req(null, "GET", `/people/${alice.handle}`)).body).toMatchObject({ counts: { issues_confirmed: 1 }, indexable: true });
    expect((await req(null, "GET", `/people/${staff.handle}`)).body).toMatchObject({ roles: ["staff"], counts: { issues_triaged: 1 } });
  });

  it("lets people hide their profile, and hides banned and unknown people", async () => {
    const p = await person();
    expect((await req(null, "GET", `/people/${p.handle}`)).res.status).toBe(200);
    expect((await req(p, "PUT", "/me/community-profile", { hidden: "yes" })).res.status).toBe(400);
    expect((await req(p, "PUT", "/me/community-profile", { hidden: true })).body).toEqual({ hidden: true });
    expect((await req(p, "GET", "/me")).body.profile_hidden).toBe(true);
    const hidden = await req(null, "GET", `/people/${p.handle}`);
    expect(hidden.res.status).toBe(404);
    expect(hidden.body.error.code).toBe("person_not_found");
    await req(p, "PUT", "/me/community-profile", { hidden: false });
    expect((await req(null, "GET", `/people/${p.handle}`)).res.status).toBe(200);

    await DB().prepare(`UPDATE users SET banned_at = ? WHERE id = ?`).bind(Date.now(), p.id).run();
    expect((await req(null, "GET", `/people/${p.handle}`)).res.status).toBe(404);
    expect((await req(null, "GET", `/people/nobody-${uniq()}`)).res.status).toBe(404);
    expect((await req(null, "PUT", "/me/community-profile", { hidden: true })).res.status).toBe(401);
    expect(requiredScope("PUT", "/v1/me/community-profile")).toBe("manage");
  });
});

describe("your own profile", () => {
  it("saves what people write about themselves and shows it on their profile", async () => {
    const p = await person();
    const saved = await req(p, "PUT", "/me/profile", {
      display_name: "  Alice  Example ", bio: "Looks into phishing kits.\nWrites about it too.", location: "Leeds", website: "alice.example.org",
      links: ["https://x.com/alice", "https://infosec.exchange/@alice"],
    });
    expect(saved.res.status).toBe(200);
    expect(saved.body).toMatchObject({
      handle: p.handle, display_name: "Alice Example", bio: "Looks into phishing kits. Writes about it too.", location: "Leeds", website: "https://alice.example.org/",
      links: [{ provider: "x", url: "https://x.com/alice" }, { provider: "mastodon", url: "https://infosec.exchange/@alice" }], hidden: false, next_handle_change_at: null,
    });
    expect((await req(p, "GET", "/me/profile")).body.display_name).toBe("Alice Example");
    const pub = (await req(null, "GET", `/people/${p.handle}`)).body;
    expect(pub).toMatchObject({ display_name: "Alice Example", location: "Leeds", website: "https://alice.example.org/", maintains: [] });
    expect(pub.links).toHaveLength(2);

    // What is left out stays; empty values clear.
    expect((await req(p, "PUT", "/me/profile", { location: "", links: [] })).body).toMatchObject({ display_name: "Alice Example", location: null, links: [] });
    expect((await req(p, "PUT", "/me/profile", { website: null })).body.website).toBeNull();
    // Hiding works here too.
    expect((await req(p, "PUT", "/me/profile", { hidden: true })).body.hidden).toBe(true);
    expect((await req(null, "GET", `/people/${p.handle}`)).res.status).toBe(404);
    expect(requiredScope("PUT", "/v1/me/profile")).toBe("manage");
    expect((await req(null, "PUT", "/me/profile", { bio: "x" })).res.status).toBe(401);
  });

  it("refuses bad fields, and personal data or keys a public profile shouldn't hold", async () => {
    const p = await person();
    expect((await req(p, "PUT", "/me/profile", { website: "javascript:alert(1)" })).body.error.code).toBe("invalid_body");
    expect((await req(p, "PUT", "/me/profile", { links: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"] })).body.error.code).toBe("invalid_body");
    expect((await req(p, "PUT", "/me/profile", { links: ["ftp://a.example"] })).body.error.code).toBe("invalid_body");
    expect((await req(p, "PUT", "/me/profile", { bio: 42 })).body.error.code).toBe("invalid_body");
    expect((await req(p, "PUT", "/me/profile", { hidden: "yes" })).body.error.code).toBe("invalid_body");
    const screened = await req(p, "PUT", "/me/profile", { bio: "Call me on +44 7700 900123 or write to alice.private@protonmail.com" });
    expect(screened.res.status).toBe(400);
    expect(screened.body.error.code).toBe("profile_screened");
    expect(screened.body.error.message).toMatch(/email/);
    expect((await req(p, "GET", "/me/profile")).body.bio).toBeNull();
    // Long text is cut to size.
    expect((await req(p, "PUT", "/me/profile", { bio: "a".repeat(600) })).body.bio).toHaveLength(400);
  });

  it("lists the packages someone looks after", async () => {
    const p = await person();
    await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES ('tool_dheeraj_whois-lite', ?, 'added', 1)`).bind(p.id).run();
    const pub = (await req(null, "GET", `/people/${p.handle}`)).body;
    expect(pub.maintains).toEqual([expect.objectContaining({ ref: "dheeraj/whois-lite", kind: "tool" })]);
    expect(pub.indexable).toBe(true);
  });

  it("changes a handle at most once every 30 days, and the old one leads to the new", async () => {
    const p = await person();
    const old = p.handle;
    const next = `n${uniq()}`;
    expect((await req(p, "PUT", "/me/handle", { handle: next.toUpperCase() })).body).toEqual({ handle: next, previous: old });
    expect((await req(p, "GET", "/me")).body.handle).toBe(next);
    const moved = (await req(null, "GET", `/people/${old}`)).body;
    expect(moved).toMatchObject({ handle: next, moved_to: next });
    expect((await req(null, "GET", `/people/${next}`)).body.moved_to).toBeUndefined();

    const soon = await req(p, "PUT", "/me/handle", { handle: `m${uniq()}` });
    expect(soon.res.status).toBe(429);
    expect(soon.body.error.code).toBe("handle_change_too_soon");
    expect(Number(soon.res.headers.get("retry-after"))).toBeGreaterThan(29 * 86_400);
    expect((await req(p, "GET", "/me/profile")).body.next_handle_change_at).toBeGreaterThan(Date.now());
    // The same handle again is no change at all.
    expect((await req(p, "PUT", "/me/handle", { handle: next })).body).toEqual({ handle: next, previous: null });

    // A month later the old handle can be taken back.
    await DB().prepare(`UPDATE users SET handle_changed_at = ? WHERE id = ?`).bind(Date.now() - 31 * 86_400_000, p.id).run();
    expect((await req(p, "PUT", "/me/handle", { handle: old })).body).toEqual({ handle: old, previous: next });
    expect((await req(null, "GET", `/people/${next}`)).body.moved_to).toBe(old);
    expect((await req(null, "GET", `/people/${old}`)).body.moved_to).toBeUndefined();
    expect(requiredScope("PUT", "/v1/me/handle")).toBe("manage");
  });

  it("refuses handles that are malformed, reserved or someone else's, now or before, or a publisher's", async () => {
    const p = await person();
    const other = await person();
    for (const bad of ["ab", "-abc", "abc-", "has space", "a".repeat(41), "under_score", "dots.here", 7]) {
      expect((await req(p, "PUT", "/me/handle", { handle: bad })).body.error.code).toBe("invalid_handle");
    }
    expect((await req(p, "PUT", "/me/handle", { handle: "admin" })).body.error.code).toBe("invalid_handle");
    expect((await req(p, "PUT", "/me/handle", { handle: other.handle })).body.error.code).toBe("handle_taken");
    // A publisher's name is taken unless you belong to it.
    expect((await req(p, "PUT", "/me/handle", { handle: "sigstore" })).body.error.code).toBe("handle_taken");
    const member = await person();
    await DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES ('ns_sigstore', ?, 'owner')`).bind(member.id).run();
    expect((await req(member, "PUT", "/me/handle", { handle: "sigstore" })).body.handle).toBe("sigstore");
    // Someone's old handle stays theirs.
    const was = other.handle;
    await req(other, "PUT", "/me/handle", { handle: `o${uniq()}` });
    expect((await req(p, "PUT", "/me/handle", { handle: was })).body.error.code).toBe("handle_taken");
  });

  it("gives a new user a fresh handle when their login is someone's old one", async () => {
    const { signIn } = await import("../src/routes/auth");
    const p = await person();
    const was = p.handle;
    await req(p, "PUT", "/me/handle", { handle: `q${uniq()}` });
    const id = await signIn(env as any, "github", { id: `gh-${uniq()}`, login: was, name: null, email: null, avatarUrl: null } as any, { accessToken: null, scopes: "" }, null);
    const h = (await DB().prepare(`SELECT handle FROM users WHERE id = ?`).bind(id).first<{ handle: string }>())!.handle;
    expect(h).not.toBe(was);
    expect(h.startsWith(`${was}-`)).toBe(true);
  });

  it("lets staff clear what someone wrote, and tells them", async () => {
    const p = await person();
    await req(p, "PUT", "/me/profile", { display_name: "Spam Spam", bio: "Buy cheap followers", website: "https://spam.example" });
    const user = await person();
    expect((await req(user, "POST", `/admin/people/${p.handle}/clear-profile`)).res.status).toBe(403);
    const staff = await person({ reviewer: true });
    expect((await req(staff, "POST", `/admin/people/${p.handle}/clear-profile`)).body).toEqual({ cleared: true });
    expect((await req(null, "GET", `/people/${p.handle}`)).body).toMatchObject({ display_name: null, bio: null, website: null, links: [] });
    const inbox = (await req(p, "GET", "/me/inbox")).body;
    expect(inbox.items[0]).toMatchObject({ kind: "moderation", scope: "account", path: "/settings/profile" });
    expect((await req(staff, "POST", "/admin/people/nobody-here/clear-profile")).res.status).toBe(404);
  });
});
