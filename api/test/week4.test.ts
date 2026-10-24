import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/lib/manifest";
import { processJob, handleBatch } from "../src/publish";
import { decrypt } from "../src/lib/crypto";
import { call, cookiesFrom, fakeHosts, sent, testEnv, webhook } from "./helpers";
import { README, fakeRelease, ghUser, installation, manifestFor, queuedJob, statuses, tagEvent } from "./fixtures";

const DB = () => env.DB;

describe("manifest validation matches the CLI", () => {
  it.each(env.TEST_FIXTURES.filter((f) => f.dir === "valid"))("accepts $name", ({ text }) => {
    expect(parseManifest(text).problems).toEqual([]);
  });
  it.each(env.TEST_FIXTURES.filter((f) => f.dir === "invalid"))("rejects $name with the expected code", ({ text }) => {
    const want = /^# expect: (\S+)/.exec(text)![1];
    expect(parseManifest(text).problems[0]?.code).toBe(want);
  });
});

// ---------- sign-in ----------

async function webSignIn(provider: "github" | "gitlab", cookie = "") {
  const start = await call(`/auth/${provider}/login?redirect=/dashboard/tools`, { headers: { cookie } });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const jar = [cookie, cookiesFrom(start)].filter(Boolean).join("; ");
  return call(`/auth/${provider}/callback?code=abc&state=${state}`, { headers: { cookie: jar } });
}

describe("sign-in", () => {
  it("signs in with GitHub, creates a session and redirects back to the site", async () => {
    fakeHosts(ghUser(5001, "alice"));
    const res = await webSignIn("github");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://otinstaller.com/dashboard/tools");
    const me = await call("/me", { headers: { cookie: cookiesFrom(res) } });
    expect(await me.json()).toMatchObject({ login: "alice", accounts: [{ provider: "github", login: "alice" }] });
  });

  it("stores provider tokens encrypted", async () => {
    fakeHosts(ghUser(5002, "bob"));
    await webSignIn("github");
    const row = await DB().prepare(`SELECT access_token_enc FROM accounts WHERE login = 'bob'`).first<{ access_token_enc: string }>();
    expect(row!.access_token_enc).not.toContain("gho_bob");
    expect(await decrypt(env.TOKEN_ENC_KEY, row!.access_token_enc)).toBe("gho_bob");
  });

  it("links GitLab to the signed-in user instead of creating a new one", async () => {
    fakeHosts(ghUser(5003, "carol"));
    const gh = await webSignIn("github");
    const session = cookiesFrom(gh);
    fakeHosts({
      "POST https://gitlab.com/oauth/token": { access_token: "glpat", refresh_token: "glrt", expires_in: 7200 },
      "GET https://gitlab.com/api/v4/user": { id: 77, username: "carol-gl", name: "Carol", email: "carol@example.com" },
    });
    await webSignIn("gitlab", session);
    const me = (await (await call("/me", { headers: { cookie: session } })).json()) as any;
    expect(me.accounts.map((a: any) => a.provider)).toEqual(["github", "gitlab"]);
  });

  it("refuses to link an account that belongs to someone else", async () => {
    fakeHosts(ghUser(5004, "dave"));
    await webSignIn("github");
    fakeHosts(ghUser(5005, "erin"));
    const erin = cookiesFrom(await webSignIn("github"));
    fakeHosts(ghUser(5004, "dave"));
    const res = await webSignIn("github", erin);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("account_already_linked");
  });

  it("rejects a callback whose state does not match", async () => {
    fakeHosts(ghUser(5006, "frank"));
    const res = await call("/auth/github/callback?code=abc&state=forged", { headers: { cookie: "ot_oauth_state=real|github|/" } });
    expect(res.status).toBe(400);
  });

  it("never redirects off-site after sign-in", async () => {
    fakeHosts(ghUser(5007, "grace"));
    const start = await call("/auth/github/login?redirect=https://evil.example/steal");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { cookie: cookiesFrom(start) } });
    expect(res.headers.get("location")).toBe("https://otinstaller.com/dashboard");
  });

  it("requires sign-in for /me", async () => {
    expect((await call("/me")).status).toBe(401);
  });
});

describe("CLI device flow and API tokens", () => {
  it("issues an API token once the user approves, and the token can be revoked", async () => {
    let approved = false;
    fakeHosts({
      "POST https://github.com/login/device/code": { device_code: "dev123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 },
      "POST https://github.com/login/oauth/access_token": () => (approved ? { access_token: "gho_heidi" } : { error: "authorization_pending" }),
      "GET https://api.github.com/user/emails": [],
      "GET https://api.github.com/user": { id: 6001, login: "heidi" },
    });
    const start = (await (await call("/auth/device/start", { method: "POST", body: JSON.stringify({ provider: "github" }) })).json()) as any;
    expect(start.user_code).toBe("ABCD-1234");
    const poll = () => call("/auth/device/token", { method: "POST", body: JSON.stringify({ provider: "github", device_code: start.device_code }) });
    expect(await (await poll()).json()).toEqual({ status: "pending" });
    approved = true;
    const done = (await (await poll()).json()) as any;
    expect(done.token).toMatch(/^ot_/);
    const auth = { authorization: `Bearer ${done.token}` };
    expect(((await (await call("/me", { headers: auth })).json()) as any).login).toBe("heidi");

    const tokens = (await (await call("/me/tokens", { headers: auth })).json()) as any;
    expect(await call(`/me/tokens/${tokens.tokens[0].id}`, { method: "DELETE", headers: auth })).toHaveProperty("status", 204);
    expect((await call("/me", { headers: auth })).status).toBe(401);
  });

  it("supports GitLab's device flow, which answers pending with HTTP 400", async () => {
    let approved = false;
    const calls = fakeHosts({
      "POST https://gitlab.com/oauth/authorize_device": { device_code: "gldev", user_code: "WXYZ", verification_uri: "https://gitlab.com/oauth/device", interval: 5 },
      "POST https://gitlab.com/oauth/token": () =>
        approved ? { access_token: "glpat-ivan", expires_in: 7200 } : Response.json({ error: "authorization_pending" }, { status: 400 }),
      "GET https://gitlab.com/api/v4/user": { id: 88, username: "ivan" },
    });
    const start = (await (await call("/auth/device/start", { method: "POST", body: JSON.stringify({ provider: "gitlab" }) })).json()) as any;
    expect(start.user_code).toBe("WXYZ");
    const poll = () => call("/auth/device/token", { method: "POST", body: JSON.stringify({ provider: "gitlab", device_code: "gldev" }) });
    expect(await (await poll()).json()).toEqual({ status: "pending" });
    approved = true;
    expect(((await (await poll()).json()) as any).login).toBe("ivan");
    // The application is confidential: GitLab rejects device-flow calls without the client secret.
    const deviceCalls = calls.filter((c) => c.url.startsWith("https://gitlab.com/oauth/"));
    expect(deviceCalls).toHaveLength(3);
    for (const c of deviceCalls) expect(new URLSearchParams(c.body).get("client_secret")).toBe("gl-secret");
  });
});

// ---------- GitHub App webhooks ----------

describe("GitHub App webhooks", () => {
  beforeEach(() => void (sent.length = 0));

  it("rejects payloads with a bad signature", async () => {
    const res = await webhook("ping", { zen: "hi" }, undefined, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("creates a namespace awaiting review on install, owned by the installer if they have signed in", async () => {
    fakeHosts(ghUser(7001, "judy"));
    await webSignIn("github");
    await webhook("installation", installation(100, { id: 7001, login: "Judy" }, [1]), undefined, undefined);
    const ns = await DB().prepare(`SELECT n.name, n.status, m.role FROM namespaces n LEFT JOIN namespace_members m ON m.namespace_id = n.id WHERE n.provider_owner_id = '7001'`).first();
    expect(ns).toMatchObject({ name: "judy", status: "pending_review" });
    // The sender (9999) is not judy, so no owner yet; installing as judy adds her.
    await webhook("installation", { ...installation(100, { id: 7001, login: "Judy" }, [1]), sender: { id: 7001 } });
    const owner = await DB().prepare(`SELECT m.role FROM namespace_members m JOIN namespaces n ON n.id = m.namespace_id WHERE n.name = 'judy'`).first();
    expect(owner).toMatchObject({ role: "owner" });
  });

  it("gives a clashing login a -gh suffix", async () => {
    // "dheeraj" already exists in the seed data as a different owner.
    await webhook("installation", installation(101, { id: 7002, login: "dheeraj" }, [2]));
    const ns = await DB().prepare(`SELECT name FROM namespaces WHERE provider_owner_id = '7002'`).first();
    expect(ns).toMatchObject({ name: "dheeraj-gh" });
  });

  it("never names a namespace after one of the site's own sections", async () => {
    await webhook("installation", installation(109, { id: 7009, login: "Community" }, [9]));
    expect(await DB().prepare(`SELECT name FROM namespaces WHERE provider_owner_id = '7009'`).first()).toMatchObject({ name: "community-gh" });
  });

  it("queues a publish job for a release tag, once per delivery", async () => {
    await webhook("installation", installation(102, { id: 7003, login: "mallory" }, [30]));
    const res = await webhook("create", tagEvent(102, "mallory/tool", 30, "v1.0.0"), "delivery-1");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued" });
    const again = await webhook("create", tagEvent(102, "mallory/tool", 30, "v1.0.0"), "delivery-1");
    expect(await again.json()).toMatchObject({ status: "duplicate delivery" });
    expect(sent).toHaveLength(1);

    // The queue gave up on it: redelivering the same delivery runs the job again.
    const job = (await DB().prepare(`SELECT id FROM publish_jobs WHERE delivery_id = 'delivery-1'`).first<{ id: string }>())!.id;
    await DB().prepare(`UPDATE publish_jobs SET status = 'error', error_code = 'internal_error', error_detail = 'GitHub answered 502' WHERE id = ?`).bind(job).run();
    const redelivered = await webhook("create", tagEvent(102, "mallory/tool", 30, "v1.0.0"), "delivery-1");
    expect(await redelivered.json()).toEqual({ status: "queued again", jobId: job });
    expect(sent).toHaveLength(2);
    expect(await DB().prepare(`SELECT status, error_code FROM publish_jobs WHERE id = ?`).bind(job).first()).toEqual({ status: "queued", error_code: null });
  });

  it("ignores non-release tags, unconnected repos and branches", async () => {
    await webhook("installation", installation(103, { id: 7004, login: "niaj" }, [40]));
    expect(await (await webhook("create", tagEvent(103, "niaj/x", 40, "nightly"))).json()).toMatchObject({ status: expect.stringMatching(/^ignored/) });
    expect(await (await webhook("create", tagEvent(103, "niaj/y", 41, "v1.0.0"))).json()).toMatchObject({ status: "ignored: repository not connected" });
    expect(await (await webhook("create", { ...tagEvent(103, "niaj/x", 40, "v1.0.0"), ref_type: "branch" })).json()).toMatchObject({ status: "ignored: not a tag" });
    expect(sent).toHaveLength(0);
  });

  it("tracks repositories added to and removed from an installation", async () => {
    await webhook("installation", installation(104, { id: 7005, login: "olivia" }, [50]));
    await webhook("installation_repositories", { installation: { id: 104 }, repositories_added: [{ id: 51 }], repositories_removed: [{ id: 50 }], repository_selection: "selected" });
    expect(await (await webhook("create", tagEvent(104, "olivia/a", 50, "v1.0.0"))).json()).toMatchObject({ status: "ignored: repository not connected" });
    expect(await (await webhook("create", tagEvent(104, "olivia/b", 51, "v1.0.0"))).json()).toMatchObject({ status: "queued" });
  });
});

// ---------- publish consumer ----------

describe("publish consumer", () => {
  it("validates a good release, records the version as scanning and reports a pending status", async () => {
    const id = await queuedJob(200, "pat", 8001, 60);
    const calls = fakeRelease("pat/whois-plus", { "otinstaller.yaml": manifestFor("pat"), "README.md": README });
    const out = await processJob(await testEnv(), id);
    expect(out).toMatchObject({ status: "scanning", problems: [] });
    const v = await DB().prepare(`SELECT v.status, v.git_sha, t.repo_url FROM versions v JOIN tools t ON t.id = v.tool_id WHERE v.id = ?`).bind(out!.versionId).first();
    expect(v).toMatchObject({ status: "scanning", git_sha: "abc123", repo_url: "https://github.com/pat/whois-plus" });
    expect(statuses(calls).map((s) => s.state)).toEqual(["pending", "pending"]);
    expect(statuses(calls)[1]!.description).toMatch(/scans running/);
    const dispatch = calls.find((c) => c.url.endsWith("/registry-ops/dispatches"))!;
    expect(JSON.parse(dispatch.body)).toMatchObject({ event_type: "otinstaller-scan", client_payload: { scan: { ref: "pat/whois-plus@1.0.0" } } });
    // Not visible until scans pass and the namespace is approved.
    expect((await call("/tools/pat/whois-plus")).status).toBe(404);
  });

  it("records the release's notes, else the version's section of CHANGELOG.md, and never fails a publish over them", async () => {
    const notes = (versionId: string) => DB().prepare(`SELECT changelog, changelog_source FROM versions WHERE id = ?`).bind(versionId).first<{ changelog: string | null; changelog_source: string | null }>();
    const files = (login: string) => ({ "otinstaller.yaml": manifestFor(login), "README.md": README });

    const a = await queuedJob(220, "una", 8020, 65);
    fakeRelease("una/whois-plus", files("una"), { extra: { "GET https://api.github.com/repositories/65/releases/tags/v1.0.0": { body: "## Fixed\r\n- \u001b[31mfaster\u001b[0m lookups‮" } } });
    const outA = await processJob(await testEnv(), a);
    expect(outA).toMatchObject({ status: "scanning" });
    expect(await notes(outA!.versionId!)).toEqual({ changelog: "## Fixed\n- [31mfaster[0m lookups", changelog_source: "release" });

    const b = await queuedJob(221, "vic", 8021, 66);
    const changelog = "# Changelog\n\n## [1.0.0] - 2026-10-01\n### Added\n- whois lookups\n\n## [0.9.0]\n- beta\n";
    fakeRelease("vic/whois-plus", { ...files("vic"), "CHANGELOG.md": changelog });
    const outB = await processJob(await testEnv(), b);
    expect(await notes(outB!.versionId!)).toEqual({ changelog: "### Added\n- whois lookups", changelog_source: "file" });

    const c = await queuedJob(222, "wes", 8022, 67);
    fakeRelease("wes/whois-plus", files("wes"), { extra: { "GET https://api.github.com/repositories/67/releases/": new Response("boom", { status: 500 }) } });
    const outC = await processJob(await testEnv(), c);
    expect(outC).toMatchObject({ status: "scanning", problems: [] });
    expect(await notes(outC!.versionId!)).toEqual({ changelog: null, changelog_source: null });
  });

  it("rejects an invalid manifest with a failed commit status naming the error", async () => {
    const id = await queuedJob(201, "quinn", 8002, 61);
    const bad = manifestFor("quinn").replace('"{domain}"', '"{host}"');
    const calls = fakeRelease("quinn/whois-plus", { "otinstaller.yaml": bad, "README.md": README });
    const out = await processJob(await testEnv(), id);
    expect(out!.problems[0]!.code).toBe("manifest_placeholder_unknown");
    const last = statuses(calls).at(-1)!;
    expect(last.state).toBe("failure");
    expect(last.description).toMatch(/^manifest_placeholder_unknown/);
    const job = await DB().prepare(`SELECT status, error_code FROM publish_jobs WHERE id = ?`).bind(id).first();
    expect(job).toMatchObject({ status: "rejected", error_code: "manifest_placeholder_unknown" });
  });

  it.each([
    ["a missing manifest", { "README.md": README }, "manifest_file_missing", "v1.0.0"],
    ["a tag that does not match the version", null, "manifest_tag_mismatch", "v2.0.0"],
    ["a manifest for another namespace", "other", "manifest_namespace_mismatch", "v1.0.0"],
    ["a missing README", { "otinstaller.yaml": "OK" }, "manifest_file_missing", "v1.0.0"],
  ] as const)("rejects %s", async (_label, files, code, tag) => {
    const login = `u${Math.floor(Math.random() * 1e6)}`;
    const id = await queuedJob(300 + Math.floor(Math.random() * 1e6), login, 9000 + Math.floor(Math.random() * 1e6), 70, tag);
    const manifest = manifestFor(files === "other" ? "someone-else" : login);
    const f = files === null || files === "other" ? { "otinstaller.yaml": manifest, "README.md": README } : Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v === "OK" ? manifest : v]));
    fakeRelease(`${login}/whois-plus`, f);
    const out = await processJob(await testEnv(), id);
    expect(out!.problems[0]!.code).toBe(code);
  });

  it("rejects an image that does not exist", async () => {
    const id = await queuedJob(210, "rita", 8010, 62);
    fakeRelease("rita/whois-plus", { "otinstaller.yaml": manifestFor("rita"), "README.md": README }, { imageStatus: 404 });
    expect((await processJob(await testEnv(), id))!.problems[0]!.code).toBe("artifact_image_not_found");
  });

  it("rejects republishing a version that already passed validation", async () => {
    const first = await queuedJob(211, "sam", 8011, 63);
    fakeRelease("sam/whois-plus", { "otinstaller.yaml": manifestFor("sam"), "README.md": README });
    await processJob(await testEnv(), first);
    const res = await webhook("create", tagEvent(211, "sam/whois-plus", 63, "v1.0.0"));
    const second = ((await res.json()) as any).jobId;
    fakeRelease("sam/whois-plus", { "otinstaller.yaml": manifestFor("sam"), "README.md": README });
    expect((await processJob(await testEnv(), second))!.problems[0]!.code).toBe("manifest_version_exists");
  });

  it("retries transient GitHub errors and gives up after five attempts", async () => {
    const id = await queuedJob(212, "tina", 8012, 64);
    fakeHosts({ "POST https://api.github.com/app/installations/": new Response("busy", { status: 502 }) });
    const acts: string[] = [];
    const msg = (attempts: number) => ({ body: { jobId: id }, attempts, ack: () => acts.push("ack"), retry: () => acts.push("retry") });
    await handleBatch({ messages: [msg(1)] } as any, await testEnv());
    await handleBatch({ messages: [msg(5)] } as any, await testEnv());
    expect(acts).toEqual(["retry", "ack"]);
    expect(await DB().prepare(`SELECT status FROM publish_jobs WHERE id = ?`).bind(id).first()).toMatchObject({ status: "error" });
  });
});

// ---------- scoped tokens (docs/agent-friendly-plan.md, phase 4) ----------

describe("scoped API tokens", () => {
  async function legacyUser(admin = false) {
    const { sha256Hex, ulid } = await import("../src/lib/crypto");
    const id = ulid();
    const token = `ot_test_${id}`;
    await DB().batch([
      DB().prepare(`INSERT INTO users (id, login, is_admin, created_at) VALUES (?, ?, ?, ?)`).bind(id, `scoped${id.slice(-6).toLowerCase()}`, admin ? 1 : 0, Date.now()),
      // Like every token minted before scopes: scoped = 0.
      DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'old', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
    ]);
    return { id, auth: { authorization: `Bearer ${token}` } };
  }
  const mint = async (auth: Record<string, string>, body: object) =>
    call("/me/tokens", { method: "POST", headers: auth, body: JSON.stringify({ name: "agent", ...body }) });

  it("mints tokens with scopes and an expiry, and refuses what a token's scopes don't cover", async () => {
    const u = await legacyUser();
    const res = await mint(u.auth, { scopes: ["read"], expires_in_days: 7 });
    expect(res.status).toBe(201);
    const ro = (await res.json()) as any;
    expect(ro.scopes).toEqual(["read"]);
    expect(ro.expires_at).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const roAuth = { authorization: `Bearer ${ro.token}` };

    expect((await call("/me", { headers: roAuth })).status).toBe(200);
    const denied = await call("/feedback", { method: "POST", headers: roAuth, body: JSON.stringify({ kind: "idea", message: "scoped tokens are nice" }) });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="feedback"');
    const err = ((await denied.json()) as any).error;
    expect(err).toMatchObject({ code: "insufficient_scope", required_scope: "feedback" });
    // A read-only token can't make tokens (manage), and a token can't mint more than it has.
    expect((await mint(roAuth, {})).status).toBe(403);
    const mgr = (await (await mint(u.auth, { scopes: ["manage"] })).json()) as any;
    expect(mgr.scopes).toEqual(["read", "manage"]);
    const escalate = await mint({ authorization: `Bearer ${mgr.token}` }, { scopes: ["publish"] });
    expect(escalate.status).toBe(403);
    expect((await mint(u.auth, { scopes: ["everything"] })).status).toBe(400);

    // The token list says what each can do, and creating and revoking are audited.
    const list = (await (await call("/me/tokens", { headers: u.auth })).json()) as any;
    expect(list.tokens.find((t: any) => t.id === ro.id).scopes).toEqual(["read"]);
    expect(list.tokens.find((t: any) => t.name === "old").scopes).toContain("publish");
    expect((await call(`/me/tokens/${ro.id}`, { method: "DELETE", headers: u.auth })).status).toBe(204);
    const actions = (await DB().prepare(`SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at`).bind(ro.id).all()).results.map((r: any) => r.action);
    expect(actions).toEqual(["token.create", "token.revoke"]);
    expect((await call("/me", { headers: roAuth })).status).toBe(401);
  });

  it("keeps staff powers off tokens unless minted with the staff scope, which tokens can't mint", async () => {
    const admin = await legacyUser(true);
    expect((await call("/admin/review-queue", { headers: admin.auth })).status).toBe(200);
    const t = (await (await mint(admin.auth, {})).json()) as any;
    expect(t.scopes).toEqual(["read", "publish", "manage", "feedback"]);
    const res = await call("/admin/review-queue", { headers: { authorization: `Bearer ${t.token}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.required_scope).toBe("staff");
    expect((await mint(admin.auth, { scopes: ["staff"] })).status).toBe(403);
  });

  it("audits writes made with a token", async () => {
    const u = await legacyUser();
    const t = (await (await mint(u.auth, { scopes: ["feedback"] })).json()) as any;
    const res = await call("/feedback", { method: "POST", headers: { authorization: `Bearer ${t.token}` }, body: JSON.stringify({ kind: "idea", message: "audit me please" }) });
    expect(res.status).toBeLessThan(300);
    const row = await DB().prepare(`SELECT metadata_json FROM audit_log WHERE action = 'token.write' AND target_id = ?`).bind(t.id).first<{ metadata_json: string }>();
    expect(JSON.parse(row!.metadata_json)).toMatchObject({ method: "POST", path: "/v1/feedback" });
  });
});
