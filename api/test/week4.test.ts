import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/lib/manifest";
import { processJob, handleBatch } from "../src/publish";
import { decrypt } from "../src/lib/crypto";
import { call, cookiesFrom, fakeHosts, sent, testEnv, webhook } from "./helpers";

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

const ghUser = (id: number, login: string) => ({
  "POST https://github.com/login/oauth/access_token": { access_token: `gho_${login}`, scope: "read:user" },
  "GET https://api.github.com/user/emails": [{ email: `${login}@example.com`, primary: true, verified: true }],
  "GET https://api.github.com/user": { id, login, name: login, email: null, avatar_url: null },
});

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
    fakeHosts({
      "POST https://gitlab.com/oauth/authorize_device": { device_code: "gldev", user_code: "WXYZ", verification_uri: "https://gitlab.com/oauth/device", interval: 5 },
      "POST https://gitlab.com/oauth/token": () =>
        approved ? { access_token: "glpat-ivan", expires_in: 7200 } : Response.json({ error: "authorization_pending" }, { status: 400 }),
      "GET https://gitlab.com/api/v4/user": { id: 88, username: "ivan" },
    });
    const poll = () => call("/auth/device/token", { method: "POST", body: JSON.stringify({ provider: "gitlab", device_code: "gldev" }) });
    expect(await (await poll()).json()).toEqual({ status: "pending" });
    approved = true;
    expect(((await (await poll()).json()) as any).login).toBe("ivan");
  });
});

// ---------- GitHub App webhooks ----------

const installation = (id: number, account: { id: number; login: string; type?: string }, repos: number[], sender = 9999) => ({
  action: "created",
  installation: { id, account: { type: "User", ...account }, repository_selection: "selected" },
  repositories: repos.map((r) => ({ id: r, full_name: `${account.login}/repo${r}` })),
  sender: { id: sender },
});

const tagEvent = (installationId: number, repo: string, repoId: number, tag: string) => ({
  ref: tag,
  ref_type: "tag",
  repository: { id: repoId, full_name: repo },
  installation: { id: installationId },
  sender: { id: 1 },
});

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

  it("queues a publish job for a release tag, once per delivery", async () => {
    await webhook("installation", installation(102, { id: 7003, login: "mallory" }, [30]));
    const res = await webhook("create", tagEvent(102, "mallory/tool", 30, "v1.0.0"), "delivery-1");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "queued" });
    const again = await webhook("create", tagEvent(102, "mallory/tool", 30, "v1.0.0"), "delivery-1");
    expect(await again.json()).toMatchObject({ status: "duplicate delivery" });
    expect(sent).toHaveLength(1);
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

const README = "# Tool\n";
const manifestFor = (ns: string, version = "1.0.0", over = "") => `schema: 1
name: whois-plus
namespace: ${ns}
version: ${version}
summary: WHOIS lookups with registrar and creation dates
readme: README.md
license: MIT
categories: [domain-dns]
inputs:
  - name: domain
    type: domain
    required: true
outputs:
  - type: organization
runtime:
  kind: docker
  image: ghcr.io/${ns}/whois-plus@sha256:${"e".repeat(64)}
  platforms: [linux/amd64]
  command: ["whois-plus", "{domain}"]
  output_format: json
ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: true
${over}`;

/** Fakes GitHub (installation token, tag, files, statuses) and ghcr.io for one repository. */
function fakeRelease(repo: string, files: Record<string, string | null>, opts: { imageStatus?: number } = {}) {
  return fakeHosts({
    "POST https://api.github.com/app/installations/": { token: "ghs_install" },
    [`GET https://api.github.com/repos/${repo}/commits/`]: { sha: "abc123" },
    [`GET https://api.github.com/repos/${repo}/contents/`]: (req) => {
      const path = decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!);
      const content = files[path];
      return content == null ? null : content;
    },
    [`POST https://api.github.com/repos/${repo}/statuses/abc123`]: { ok: true },
    "GET https://ghcr.io/v2/": (req) =>
      req.headers.get("authorization")
        ? new Response(JSON.stringify({ schemaVersion: 2 }), { status: opts.imageStatus ?? 200 })
        : new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"' } }),
    "GET https://ghcr.io/token": { token: "anon" },
  });
}

async function queuedJob(installationId: number, login: string, ownerId: number, repoId: number, tag = "v1.0.0") {
  await webhook("installation", installation(installationId, { id: ownerId, login }, [repoId]));
  const res = await webhook("create", tagEvent(installationId, `${login}/whois-plus`, repoId, tag));
  return ((await res.json()) as any).jobId as string;
}

const statuses = (calls: { url: string; body: string }[]) =>
  calls.filter((c) => c.url.includes("/statuses/")).map((c) => JSON.parse(c.body) as { state: string; description: string });

describe("publish consumer", () => {
  it("validates a good release, records the version as scanning and reports a pending status", async () => {
    const id = await queuedJob(200, "pat", 8001, 60);
    const calls = fakeRelease("pat/whois-plus", { "otinstaller.yaml": manifestFor("pat"), "README.md": README });
    const out = await processJob(await testEnv(), id);
    expect(out).toMatchObject({ status: "scanning", problems: [] });
    const v = await DB().prepare(`SELECT v.status, v.git_sha, t.repo_url FROM versions v JOIN tools t ON t.id = v.tool_id WHERE v.id = ?`).bind(out!.versionId).first();
    expect(v).toMatchObject({ status: "scanning", git_sha: "abc123", repo_url: "https://github.com/pat/whois-plus" });
    expect(statuses(calls).map((s) => s.state)).toEqual(["pending", "pending"]);
    expect(statuses(calls)[1]!.description).toMatch(/awaiting review/);
    // Not visible until scans pass and the namespace is approved.
    expect((await call("/tools/pat/whois-plus")).status).toBe(404);
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
