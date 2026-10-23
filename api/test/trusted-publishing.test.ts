import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processJob } from "../src/publish";
import { purgeCiTokens, CI_TOKEN_RETENTION } from "../src/trusted";
import { resetOidcCaches } from "../src/lib/oidc";
import { b64url, sha256Hex, ulid } from "../src/lib/crypto";
import { mirrorFetch } from "../src/mirror/registry";
import { call, fakeHosts, testEnv, webhook, type Handler } from "./helpers";
import { manifestFor, tagEvent } from "./fixtures";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(3, "0")}`;

const GH = "https://token.actions.githubusercontent.com";
const GL = "https://gitlab.com";
let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;
let otherKeys: CryptoKeyPair;

beforeAll(async () => {
  const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = (await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
});
beforeEach(() => resetOidcCaches());

// ---------- fakes ----------

/** GitHub's and GitLab's OIDC issuers, ghcr.io, the scanner dispatch and email. */
function hosts(extra: Record<string, Handler> = {}) {
  const jwks = { keys: [{ kty: "RSA", n: publicJwk.n, e: publicJwk.e, kid: "k1", alg: "RS256", use: "sig" }] };
  return fakeHosts({
    [`GET ${GH}/.well-known/openid-configuration`]: { issuer: GH, jwks_uri: `${GH}/.well-known/jwks` },
    [`GET ${GH}/.well-known/jwks`]: jwks,
    [`GET ${GL}/.well-known/openid-configuration`]: { issuer: GL, jwks_uri: `${GL}/oauth/discovery/keys` },
    [`GET ${GL}/oauth/discovery/keys`]: jwks,
    "GET https://ghcr.io/v2/": (req) =>
      req.headers.get("authorization")
        ? new Response(JSON.stringify({ schemaVersion: 2 }))
        : new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"' } }),
    "GET https://ghcr.io/token": { token: "anon" },
    "POST https://api.github.com/app/installations/": { token: "ghs_ops" },
    "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response(null, { status: 204 }),
    "POST https://api.resend.com/emails": { id: "email" },
    ...extra,
  });
}

async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; alg?: string; kid?: string } = {}) {
  const head = b64url(JSON.stringify({ alg: o.alg ?? "RS256", typ: "JWT", kid: o.kid ?? "k1" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, o.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** A GitHub Actions ID token's claims for a release workflow on the default branch of `repo`. */
function github(repo: string, over: Record<string, unknown> = {}) {
  return {
    iss: GH, aud: "otinstaller", sub: `repo:${repo}:ref:refs/heads/main`, jti: crypto.randomUUID(), iat: now(), nbf: now(), exp: now() + 300,
    repository: repo, repository_id: `r${repo}`, repository_owner: repo.split("/")[0], repository_owner_id: `o${repo.split("/")[0]}`, repository_visibility: "public",
    ref: "refs/heads/main", ref_type: "branch", sha: "a".repeat(40), workflow: "Release",
    workflow_ref: `${repo}/.github/workflows/release.yml@refs/heads/main`, job_workflow_ref: `${repo}/.github/workflows/release.yml@refs/heads/main`,
    event_name: "workflow_dispatch", run_id: "77", run_attempt: "1", actor: "alice", ...over,
  };
}

/** A GitLab CI ID token's claims for a pipeline on `project`'s default branch. */
function gitlab(project: string, over: Record<string, unknown> = {}) {
  return {
    iss: GL, aud: "otinstaller", sub: `project_path:${project}:ref_type:branch:ref:main`, jti: crypto.randomUUID(), iat: now(), nbf: now(), exp: now() + 3600,
    project_path: project, project_id: `p${project}`, namespace_id: `g${project.split("/")[0]}`, namespace_path: project.split("/")[0], project_visibility: "public",
    ref: "main", ref_type: "branch", ref_path: "refs/heads/main", sha: "b".repeat(40), ci_config_ref_uri: `gitlab.com/${project}//.gitlab-ci.yml@refs/heads/main`,
    pipeline_source: "web", pipeline_id: "900", job_id: "901", user_login: "bob", ...over,
  };
}

// ---------- helpers ----------

async function person(role?: { ns: string; role: string }) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(id, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES (?, ?, 'cli', ?, 'read', 0, ?)`)
      .bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  if (role) await member(role.ns, id, role.role);
  return { id, login, auth: { authorization: `Bearer ${token}` } };
}

type Person = Awaited<ReturnType<typeof person>>;

async function member(ns: string, userId: string, role = "owner") {
  await DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) SELECT id, ?, ? FROM namespaces WHERE name = ?`).bind(userId, role, ns).run();
}

/** An approved registry namespace and its owner. */
async function namespace() {
  const name = `ns${uniq()}`;
  const id = ulid();
  await DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, display_name, status, created_at) VALUES (?, 'registry', ?, ?, 'user', ?, 'active', ?)`)
    .bind(id, id, name, name, Date.now()).run();
  const owner = await person({ ns: name, role: "owner" });
  return { ns: name, id, owner };
}

const json = (auth: Record<string, string>, method: string, body?: unknown): RequestInit =>
  ({ method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const trust = (p: Person, ns: string, body: Record<string, unknown>) => call(`/me/namespaces/${ns}/trusted-publishers`, json(p.auth, "POST", body));

async function exchange(idToken: string, namespace: string, pkg = "whois-plus") {
  return call("/auth/oidc/token", json({}, "POST", { id_token: idToken, namespace, package: pkg }));
}

/** Trades claims for a CI token, expecting it to work. */
async function ciToken(claims: Record<string, unknown>, ns: string, pkg = "whois-plus") {
  const res = await exchange(await sign(claims), ns, pkg);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { token: string };
  return { authorization: `Bearer ${body.token}` };
}

async function upload(auth: Record<string, string>, ns: string, version = "1.0.0", manifest = manifestFor(ns, version), name = "whois-plus") {
  const form = new FormData();
  for (const [path, content] of Object.entries({ "otinstaller.yaml": manifest, "README.md": "# Tool\n\nSee [the docs](docs/guide.md).\n" })) form.append(path, new Blob([content]), path);
  const req = new Response(form);
  const body = await req.arrayBuffer();
  return call(`/publish?namespace=${ns}&name=${name}&version=${version}`, {
    method: "POST",
    headers: { ...auth, "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) },
    body,
  });
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

// ---------- managing trusted publishers ----------

describe("trusted publishers", () => {
  it("are added, listed and removed by a namespace's owners only", async () => {
    const { ns, owner } = await namespace();
    hosts();
    const add = await trust(owner, ns, { provider: "github", repository: "Alice/Tool", workflow: ".github/workflows/release.yml" });
    expect(add.status).toBe(201);
    const p = (await add.json()) as any;
    expect(p).toMatchObject({ provider: "github", repository: "alice/tool", workflow: "release.yml", environment: null, package: null, pinned: false, created_by: owner.login });
    expect((await trust(owner, ns, { provider: "github", repository: "alice/tool", workflow: "release.yml" })).status).toBe(409);
    expect(await errorCode(await trust(owner, ns, { provider: "github", repository: "not a repo" }))).toMatchObject({ code: "invalid_body" });
    expect(await errorCode(await trust(owner, ns, { provider: "bitbucket", repository: "a/b" }))).toMatchObject({ code: "invalid_body" });

    const publisher = await person({ ns, role: "publisher" });
    const stranger = await person();
    expect((await trust(publisher, ns, { provider: "gitlab", repository: "group/project" })).status).toBe(403);
    expect((await call(`/me/namespaces/${ns}/trusted-publishers`, { headers: stranger.auth })).status).toBe(403);

    const list = (await (await call(`/me/namespaces/${ns}/trusted-publishers`, { headers: owner.auth })).json()) as any;
    expect(list.publishers.map((x: any) => x.id)).toEqual([p.id]);
    expect((await call(`/me/namespaces/${ns}/trusted-publishers/${p.id}`, json(owner.auth, "DELETE"))).status).toBe(204);
    expect((await call(`/me/namespaces/${ns}/trusted-publishers/${p.id}`, json(owner.auth, "DELETE"))).status).toBe(404);
  });
});

// ---------- exchanging an ID token ----------

describe("a CI run's ID token", () => {
  it("is traded once for an hour-long token restricted to the namespace", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    expect((await trust(owner, ns, { provider: "github", repository: repo, workflow: "release.yml" })).status).toBe(201);
    const id = await sign(github(repo));
    const res = await exchange(id, ns);
    expect(res.status, await res.clone().text()).toBe(200);
    const t = (await res.json()) as any;
    expect(t).toMatchObject({ namespace: ns, package: "whois-plus", repository: `github:${repo}`, workflow: "release.yml" });
    expect(t.token).toMatch(/^ot_/);
    expect(t.expires_at - Date.now()).toBeGreaterThan(3500_000);
    expect(t.expires_at - Date.now()).toBeLessThanOrEqual(3600_000);
    // The same ID token works once.
    expect(await errorCode(await exchange(id, ns))).toMatchObject({ code: "oidc_token_reused" });
    // The first run pins the repository's id: a repository created again under the name can't publish.
    const reborn = await exchange(await sign(github(repo, { repository_id: "r-new" })), ns);
    expect(reborn.status).toBe(403);
    expect((await errorCode(reborn)).message).toContain("id changed");
    // CI tokens act for the owner but aren't theirs to list.
    const mine = (await (await call("/me/tokens", { headers: owner.auth })).json()) as any;
    expect(mine.tokens.some((x: any) => x.name.startsWith("ci "))).toBe(false);
    const audit = await DB().prepare(`SELECT actor_id, actor_kind FROM audit_log WHERE action = 'token.create_ci' ORDER BY created_at DESC LIMIT 1`).first<any>();
    expect(audit).toEqual({ actor_id: owner.id, actor_kind: "github" });
  });

  it("is refused when nothing trusts the run", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    const untrusted = await exchange(await sign(github(repo)), ns);
    expect(untrusted.status).toBe(403);
    expect(await errorCode(untrusted)).toMatchObject({ code: "publisher_not_trusted" });

    await trust(owner, ns, { provider: "github", repository: repo, workflow: "release.yml", package: "whois-plus" });
    const wrongWorkflow = github(repo, { job_workflow_ref: `${repo}/.github/workflows/test.yml@refs/heads/main` });
    expect((await errorCode(await exchange(await sign(wrongWorkflow), ns))).message).toContain("test.yml, not release.yml");
    expect((await errorCode(await exchange(await sign(github(repo)), ns, "other-tool"))).message).toContain("whois-plus only");
    // A reusable workflow from another repository doesn't sign as this one.
    const borrowed = github(repo, { job_workflow_ref: "evil/actions/.github/workflows/release.yml@refs/heads/main" });
    expect(await errorCode(await exchange(await sign(borrowed), ns))).toMatchObject({ code: "oidc_token_invalid" });
    const hidden = await exchange(await sign(github(repo, { repository_visibility: "private" })), ns);
    expect(await errorCode(hidden)).toMatchObject({ code: "publisher_not_trusted" });
    // pull_request_target runs base-repository workflows on others' code: only behind an environment.
    expect((await errorCode(await exchange(await sign(github(repo, { event_name: "pull_request_target" })), ns))).message).toContain("environment");
  });

  it("accepts a risky event only through a publisher that requires an environment", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo, environment: "Release" });
    expect((await errorCode(await exchange(await sign(github(repo)), ns))).message).toContain("must run in the Release environment");
    expect((await exchange(await sign(github(repo, { environment: "release", event_name: "pull_request_target" })), ns)).status).toBe(200);
  });

  it("must be a valid token for the otinstaller audience", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const bad = async (token: string) => {
      const res = await exchange(token, ns);
      expect(res.status).toBe(401);
      return errorCode(res);
    };
    expect(await bad(await sign(github(repo, { aud: "sigstore" })))).toMatchObject({ code: "oidc_token_invalid", message: expect.stringContaining("audience") });
    expect((await bad(await sign(github(repo, { exp: now() - 120, iat: now() - 600 })))).message).toContain("expiry");
    expect((await bad(await sign(github(repo, { exp: now() + 3 * 86400 })))).message).toContain("lifetime");
    expect((await bad(await sign(github(repo), { key: otherKeys.privateKey }))).message).toContain("signature is invalid");
    expect((await bad(await sign(github(repo), { kid: "unknown" }))).message).toContain("no GitHub signing key");
    expect((await bad(await sign(github(repo, { iss: "https://token.example.com" })))).message).toContain("not accepted");
    expect((await bad("not-a-jwt")).code).toBe("oidc_token_invalid");
  });

  it("stops working when its publisher is removed or its creator leaves", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    const p = (await (await trust(owner, ns, { provider: "github", repository: repo })).json()) as any;
    const auth = await ciToken(github(repo), ns);
    expect((await call(`/me/namespaces/${ns}/trusted-publishers/${p.id}`, json(owner.auth, "DELETE"))).status).toBe(204);
    expect((await upload(auth, ns)).status).toBe(401);

    await trust(owner, ns, { provider: "github", repository: repo });
    await DB().prepare(`DELETE FROM namespace_members WHERE user_id = ?`).bind(owner.id).run();
    expect((await errorCode(await exchange(await sign(github(repo)), ns))).message).toContain("no longer in");
  });

  it("works from GitLab CI", async () => {
    const { ns, owner } = await namespace();
    const project = `group${uniq()}/sub/tool`;
    hosts();
    await trust(owner, ns, { provider: "gitlab", repository: project, workflow: ".gitlab-ci.yml" });
    const auth = await ciToken(gitlab(project), ns);
    const res = await upload(auth, ns);
    expect(res.status, await res.clone().text()).toBe(202);
    const job = await DB().prepare(`SELECT provider, repo, repo_id, tag, commit_sha FROM publish_jobs WHERE id = ?`).bind(((await res.json()) as any).job_id).first<any>();
    expect(job).toEqual({ provider: "gitlab", repo: project, repo_id: `p${project}`, tag: "v1.0.0", commit_sha: null });
    // GitLab refuses merge-request pipelines unless an environment is required.
    expect((await errorCode(await exchange(await sign(gitlab(project, { pipeline_source: "merge_request_event" })), ns))).code).toBe("publisher_not_trusted");
  });
});

// ---------- the restricted token ----------

describe("a CI token", () => {
  it("only uploads and follows its jobs; anywhere else it is anonymous", async () => {
    const { ns, id, owner } = await namespace();
    const other = await namespace();
    await member(other.ns, owner.id);
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const auth = await ciToken(github(repo), ns);
    expect((await call("/me", { headers: auth })).status).toBe(401);
    expect((await call("/me/tokens", json(auth, "POST", { name: "escalate" }))).status).toBe(401);
    expect((await call(`/me/namespaces/${ns}/trusted-publishers`, { headers: auth })).status).toBe(401);
    expect((await call("/tools", { headers: auth })).status).toBe(200);
    // Not into another namespace its creator owns, nor another package.
    expect(await errorCode(await upload(auth, other.ns))).toMatchObject({ code: "forbidden" });
    expect((await upload(auth, ns, "1.0.0", manifestFor(ns).replace("name: whois-plus", "name: other-tool"), "other-tool")).status).toBe(403);
    // Expired tokens are deleted once the ID tokens they came from can no longer be valid.
    await DB().prepare(`UPDATE api_tokens SET expires_at = ? WHERE namespace_id = ?`).bind(Date.now() - CI_TOKEN_RETENTION - 1000, id).run();
    expect(await purgeCiTokens(await testEnv())).toBeGreaterThanOrEqual(1);
    expect(await DB().prepare(`SELECT 1 FROM api_tokens WHERE namespace_id = ?`).bind(id).first()).toBeNull();
  });

  it("publishes as the repository: its name, links and expected signer", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    await trust(owner, ns, { provider: "github", repository: repo });
    const calls = hosts();
    const auth = await ciToken(github(repo), ns);
    const res = await upload(auth, ns);
    expect(res.status, await res.clone().text()).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    const job = (await (await call(`/me/publish-jobs/${job_id}`, { headers: auth })).json()) as any;
    expect(job).toMatchObject({ method: "ci", provider: "github", repo, tag: "v1.0.0", ci: { workflow: "release.yml", ref: "refs/heads/main", run: "77/1" } });
    expect((await processJob(await testEnv(), job_id))?.status).toBe("scanning");
    const scan = JSON.parse(calls.find((c) => c.url.endsWith("/registry-ops/dispatches"))!.body).client_payload.scan;
    expect(scan.source_repo).toBe(`github.com/${repo}`);
    expect(scan.expected_signer.issuer).toBe(GH);
    expect(new RegExp(scan.expected_signer.identityRegexp).test(`https://github.com/${repo}/.github/workflows/release.yml@refs/heads/main`)).toBe(true);
    const tool = await DB().prepare(`SELECT t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = 'whois-plus'`).bind(ns).first<any>();
    expect(tool.repo_url).toBe(`https://github.com/${repo}`);
    // The name now belongs to the repository: a direct upload or another repository's CI can't take it.
    expect(await errorCode(await upload(owner.auth, ns, "1.1.0"))).toMatchObject({ code: "manifest_name_taken" });
    const fork = `mallory${uniq()}/tool`;
    await trust(owner, ns, { provider: "github", repository: fork });
    expect(await errorCode(await upload(await ciToken(github(fork), ns), ns, "1.1.0"))).toMatchObject({ code: "manifest_name_taken" });
  });

  it("takes the tag and commit from a run for a tag", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const auth = await ciToken(github(repo, { ref: "refs/tags/v1.0.0", ref_type: "tag", sha: "c".repeat(40) }), ns);
    const res = await upload(auth, ns);
    const job = await DB().prepare(`SELECT tag, commit_sha FROM publish_jobs WHERE id = ?`).bind(((await res.json()) as any).job_id).first<any>();
    expect(job).toEqual({ tag: "v1.0.0", commit_sha: "c".repeat(40) });
  });

  it("pushes only its own package's image to the mirror", async () => {
    const { ns, owner } = await namespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const auth = await ciToken(github(repo), ns);
    const menv = { MIRROR: env.MIRROR, MIRROR_PUSH_TOKEN: "push-secret", DB: env.DB };
    const m = (path: string, init: RequestInit = {}) => mirrorFetch(new Request(`https://mirror.otinstaller.com${path}`, init), menv);
    const pushTo = async (name: string) => {
      const res = await m(`/token?scope=repository:${name}:pull,push`, { headers: { authorization: `Basic ${btoa(`ot:${auth.authorization.slice(7)}`)}` } });
      const bearer = `Bearer ${((await res.json()) as { token: string }).token}`;
      return (await m(`/v2/${name}/blobs/uploads/`, { method: "POST", headers: { authorization: bearer } })).status;
    };
    expect(await pushTo(`${ns}/whois-plus`)).toBe(202);
    expect(await pushTo(`${ns}/other-tool`)).not.toBe(202);
  });
});

// ---------- the same release from the App and from CI ----------

describe("a release that comes in twice", () => {
  async function appNamespace() {
    const { ns, id, owner } = await namespace();
    const instId = Number(String(Date.now()).slice(-8)) + ++n;
    await DB().prepare(`UPDATE namespaces SET provider = 'github', provider_owner_id = ? WHERE id = ?`).bind(`gh${instId}`, id).run();
    await DB().prepare(`INSERT INTO installations (id, github_installation_id, namespace_id, repo_ids, repository_selection) VALUES (?, ?, ?, '[]', 'all')`).bind(ulid(), instId, id).run();
    return { ns, id, owner, instId };
  }

  it("is followed, not uploaded again, when the App's webhook got the tag first", async () => {
    const { ns, owner, instId } = await appNamespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const claims = github(repo, { repository_id: String(800000 + ++n) });
    expect((await webhook("create", tagEvent(instId, repo, Number(claims.repository_id), "v1.0.0"))).status).toBe(202);
    const res = await upload(await ciToken(claims, ns), ns);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ already_received: true, status: "queued" });
  });

  it("skips the App's tag job when CI uploaded the release first", async () => {
    const { ns, owner, instId } = await appNamespace();
    const repo = `alice${uniq()}/tool`;
    hosts();
    await trust(owner, ns, { provider: "github", repository: repo });
    const claims = github(repo, { repository_id: String(700000 + ++n) });
    expect((await upload(await ciToken(claims, ns), ns)).status).toBe(202);
    const res = await webhook("create", tagEvent(instId, repo, Number(claims.repository_id), "v1.0.0"));
    expect(await res.json()).toMatchObject({ status: "ignored: uploaded by the repository's CI" });
  });
});
