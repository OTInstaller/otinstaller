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
