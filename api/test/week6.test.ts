import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { processJob } from "../src/publish";
import { expectedSigner } from "../src/scans";
import { pollDueSources, pollSource, sourceById } from "../src/sync";
import { encrypt, sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, sent, testEnv, webhook } from "./helpers";
import { README, manifestFor } from "./fixtures";

const DB = () => env.DB;
const GL = "https://gitlab.com/api/v4/projects/";
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

beforeEach(() => void (sent.length = 0));

describe("expected signer", () => {
  it.each([
    ["github", "acme/tool", "https://github.com/acme/tool/.github/workflows/otinstaller-release.yml@refs/heads/main", true],
    ["github", "acme/tool", "https://github.com/acme/tool/.github/workflows/release.yml@refs/tags/v1.2.0", true],
    ["github", "acme/tool", "https://github.com/acme/tool/.github/workflows/release.yml@refs/tags/v9.9.9", false],
    ["github", "acme/tool", "https://github.com/evil/tool/.github/workflows/release.yml@refs/heads/main", false],
    ["gitlab", "group/sub/tool", "https://gitlab.com/group/sub/tool//.gitlab-ci.yml@refs/heads/main", true],
    ["gitlab", "group/sub/tool", "https://gitlab.com/group/sub/tool-fork//.gitlab-ci.yml@refs/heads/main", false],
  ] as const)("%s %s accepts %s: %s", (provider, repo, identity, ok) => {
    expect(new RegExp(expectedSigner(provider, repo, "v1.2.0").identityRegexp).test(identity)).toBe(ok);
  });
  it("uses each host's OIDC issuer", () => {
    expect(expectedSigner("gitlab", "a/b", "v1.0.0").issuer).toBe("https://gitlab.com");
    expect(expectedSigner("github", "a/b", "v1.0.0").issuer).toBe("https://token.actions.githubusercontent.com");
  });
});

// ---------- GitLab ----------

/** A user with a linked GitLab account; returns their API token header. */
async function gitlabUser(opts: { expired?: boolean } = {}) {
  const id = ulid();
  const token = `ot_gl_${id}`;
  const login = `gl${uniq()}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(id, login, `${login}@example.com`, Date.now()),
    DB().prepare(
      `INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, refresh_token_enc, expires_at, created_at) VALUES (?, ?, 'gitlab', ?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(), id, uniq(), login, await encrypt(env.TOKEN_ENC_KEY, "glpat-old"), await encrypt(env.TOKEN_ENC_KEY, "glrt-1"),
      opts.expired ? Date.now() - 1000 : Date.now() + 3600_000, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { userId: id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

const project = (id: number, path: string, over: Record<string, unknown> = {}) => ({
  id, path_with_namespace: path, web_url: `https://gitlab.com/${path}`, visibility: "public", default_branch: "main", archived: false,
  namespace: { id: id + 1000, path: path.split("/")[0], kind: "user", full_path: path.split("/")[0] },
  permissions: { project_access: { access_level: 40 }, group_access: null }, star_count: 3, topics: ["osint"], description: "d",
  ...over,
});

async function connect(user: Awaited<ReturnType<typeof gitlabUser>>, p: ReturnType<typeof project>, routes: Parameters<typeof fakeHosts>[0] = {}) {
  let secret = "";
  fakeHosts({
    ...routes,
    [`GET ${GL}`]: p,
    [`POST ${GL}${p.id}/hooks`]: async (req) => {
      secret = ((await req.json()) as { token: string }).token;
      return { id: 555 };
    },
  });
  const res = await call("/sources/gitlab", { method: "POST", headers: user.auth, body: JSON.stringify({ project: `https://gitlab.com/${p.path_with_namespace}` }) });
  return { res, body: (await res.json()) as any, secret };
}

const gitlabWebhook = (payload: unknown, token: string, uuid = crypto.randomUUID()) =>
  call("/webhooks/gitlab", { method: "POST", headers: { "x-gitlab-token": token, "x-gitlab-event-uuid": uuid, "content-type": "application/json" }, body: JSON.stringify(payload) });

const tagPush = (p: ReturnType<typeof project>, tag: string, after = "abc123") => ({
  object_kind: "tag_push", ref: `refs/tags/${tag}`, after, project_id: p.id, project: { id: p.id, path_with_namespace: p.path_with_namespace, default_branch: "main" },
});

describe("connecting GitLab projects", () => {
  it("connects a public project, creates its webhook and a namespace awaiting review", async () => {
    const user = await gitlabUser();
    const p = project(Number(uniq()), `${user.login}/whois-plus`);
    const { res, body, secret } = await connect(user, p);
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ project: p.path_with_namespace, namespace: user.login, namespace_status: "pending_review", role: "owner" });
    expect(secret.length).toBeGreaterThan(20);
    const src = await DB().prepare(`SELECT webhook_id, webhook_secret_hash, tool_id FROM sources WHERE id = ?`).bind(body.source_id).first<any>();
    expect(src).toMatchObject({ webhook_id: "555", tool_id: null });
    expect(src.webhook_secret_hash).toBe(await sha256Hex(secret));
  });

  it.each([
    ["Developer access", { permissions: { project_access: { access_level: 30 } } }, 403, "not_maintainer"],
    ["a private project", { visibility: "private" }, 400, "project_not_public"],
  ])("refuses %s", async (_l, over, status, code) => {
    const user = await gitlabUser();
    const { res, body } = await connect(user, project(Number(uniq()), `${user.login}/x`, over));
    expect(res.status).toBe(status);
    expect(body.error.code).toBe(code);
  });

  it("asks the user to re-authorize when the webhook needs the api scope", async () => {
    const user = await gitlabUser();
    const p = project(Number(uniq()), `${user.login}/x`);
    fakeHosts({ [`GET ${GL}`]: p, [`POST ${GL}${p.id}/hooks`]: new Response("insufficient_scope", { status: 403 }) });
    const res = await call("/sources/gitlab", { method: "POST", headers: user.auth, body: JSON.stringify({ project: p.path_with_namespace }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatchObject({ code: "gitlab_scope_required", hint: expect.stringContaining("scope=api") });
  });

  it("refreshes an expired GitLab token before using it", async () => {
    const user = await gitlabUser({ expired: true });
    const p = project(Number(uniq()), `${user.login}/x`);
    const calls = fakeHosts({
      "POST https://gitlab.com/oauth/token": { access_token: "glpat-new", refresh_token: "glrt-2", expires_in: 7200 },
      [`GET ${GL}`]: p,
      [`POST ${GL}${p.id}/hooks`]: { id: 1 },
    });
    expect((await call("/sources/gitlab", { method: "POST", headers: user.auth, body: JSON.stringify({ project: p.path_with_namespace }) })).status).toBe(201);
    expect(calls[0]!.url).toBe("https://gitlab.com/oauth/token");
  });
});

describe("GitLab webhooks and publishing", () => {
  async function connected() {
    const user = await gitlabUser();
    const p = project(Number(uniq()), `${user.login}/whois-plus`);
    const { body, secret } = await connect(user, p);
    return { user, p, sourceId: body.source_id as string, secret };
  }

  it("rejects a wrong token and ignores deleted or non-release tags", async () => {
    const { p, secret } = await connected();
    expect((await gitlabWebhook(tagPush(p, "v1.0.0"), "wrong")).status).toBe(401);
    expect(await (await gitlabWebhook(tagPush(p, "v1.0.0", "0000000000000000000000000000000000000000"), secret)).json()).toMatchObject({ status: "ignored: tag deleted" });
    expect(await (await gitlabWebhook(tagPush(p, "latest"), secret)).json()).toMatchObject({ status: "ignored: not a vX.Y.Z tag" });
    expect(sent).toHaveLength(0);
  });

  it("queues a release tag once per event", async () => {
    const { p, secret } = await connected();
    const res = await gitlabWebhook(tagPush(p, "v1.0.0"), secret, "evt-1");
    expect(res.status).toBe(202);
    expect(await (await gitlabWebhook(tagPush(p, "v1.0.0"), secret, "evt-1")).json()).toMatchObject({ status: "duplicate delivery" });
    expect(sent).toHaveLength(1);
  });

  it("validates a GitLab release, reports to GitLab, and scans it with GitLab's signer identity", async () => {
    const { user, p, secret } = await connected();
    const jobId = ((await (await gitlabWebhook(tagPush(p, "v1.0.0"), secret)).json()) as any).jobId;
    const manifest = manifestFor(user.login).replace(`ghcr.io/${user.login}/whois-plus`, `registry.gitlab.com/${user.login}/whois-plus`);
    const calls = fakeHosts({
      [`GET ${GL}${p.id}/repository/tags/`]: { commit: { id: "abc123" } },
      [`GET ${GL}${p.id}/repository/files/`]: (req) => {
        const path = decodeURIComponent(new URL(req.url).pathname.split("/files/")[1]!.replace(/\/raw$/, ""));
        return ({ "otinstaller.yaml": manifest, "README.md": README } as Record<string, string>)[path] ?? null;
      },
      [`POST ${GL}${p.id}/statuses/abc123`]: { id: 1 },
      "GET https://registry.gitlab.com/v2/": { schemaVersion: 2 },
      "POST https://api.github.com/app/installations/": { token: "ghs_ops" },
      "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response(null, { status: 204 }),
      "POST https://api.resend.com/emails": { id: "e" },
    });
    const out = await processJob(await testEnv(), jobId);
    expect(out).toMatchObject({ status: "scanning", problems: [] });
    const statuses = calls.filter((c) => c.url.includes("/statuses/")).map((c) => JSON.parse(c.body));
    expect(statuses.map((s) => s.state)).toEqual(["running", "running"]);
    expect(statuses[0].name).toBe("otinstaller/publish");
    const scan = JSON.parse(calls.find((c) => c.url.endsWith("/dispatches"))!.body).client_payload.scan;
    expect(scan.source_repo).toBe(`gitlab.com/${p.path_with_namespace}`);
    expect(scan.expected_signer.issuer).toBe("https://gitlab.com");
    const tool = await DB().prepare(`SELECT t.repo_url, s.tool_id FROM tools t JOIN sources s ON s.tool_id = t.id WHERE t.id = (SELECT tool_id FROM publish_jobs WHERE id = ?)`).bind(jobId).first<any>();
    expect(tool.repo_url).toBe(`https://gitlab.com/${p.path_with_namespace}`);
  });

  it("records release notes as the version's changelog", async () => {
    const { p, secret, sourceId } = await connected();
    const toolId = ulid();
    await DB().batch([
      DB().prepare(`INSERT INTO tools (id, namespace_id, name, summary, categories, created_at, updated_at) SELECT ?, namespace_id, ?, 's', '[]', 0, 0 FROM sources WHERE id = ?`).bind(toolId, `t${uniq()}`, sourceId),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, created_at) VALUES (?, ?, '1.0.0', 1, 0, 0, '{}', 'published', 0)`).bind(ulid(), toolId),
      DB().prepare(`UPDATE sources SET tool_id = ? WHERE id = ?`).bind(toolId, sourceId),
    ]);
    await gitlabWebhook({ object_kind: "release", action: "create", tag: "v1.0.0", description: "Faster lookups", project: { id: p.id } }, secret);
    expect(await DB().prepare(`SELECT changelog FROM versions WHERE tool_id = ?`).bind(toolId).first()).toMatchObject({ changelog: "Faster lookups" });
  });
});

// ---------- sync ----------

/** A published GitHub package with its source row, ready to sync. */
async function githubPackage() {
  const u = uniq();
  const login = `sync${u}`;
  const nsId = ulid(), toolId = ulid(), verId = ulid(), srcId = ulid(), userId = ulid();
  const token = `ot_sync_${u}`;
  await DB().batch([
    DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, 'github', ?, ?, 'user', 'active', 0)`).bind(nsId, `o${u}`, login),
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, 0)`).bind(userId, login, `${login}@example.com`),
    DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(nsId, userId),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, 0)`).bind(ulid(), userId, await sha256Hex(token)),
    DB().prepare(`INSERT INTO tools (id, namespace_id, name, summary, categories, latest_version_id, repo_url, created_at, updated_at) VALUES (?, ?, 'scraper', 'A scraper for sync tests', '["utilities"]', ?, ?, 0, 0)`)
      .bind(toolId, nsId, verId, `https://github.com/${login}/scraper`),
    DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.0.0', 1, 0, 0, ?, 'published', 0, 0)`)
      .bind(verId, toolId, JSON.stringify({ readme: "README.md" })),
    DB().prepare(`INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url, installation_id, created_at) VALUES (?, ?, ?, 'github', ?, ?, ?, 4242, 0)`)
      .bind(srcId, toolId, nsId, `9${u}`, `${login}/scraper`, `https://github.com/${login}/scraper`),
  ]);
  return { login, toolId, srcId, repoId: `9${u}`, path: `${login}/scraper`, auth: { authorization: `Bearer ${token}` } };
}

function fakeGithubRepo(pkg: Awaited<ReturnType<typeof githubPackage>>, meta: Record<string, unknown> | null, tags: string[] = ["v1.0.0"], opts: { etag?: string } = {}) {
  return fakeHosts({
    "POST https://api.github.com/app/installations/": { token: "ghs" },
    [`GET https://api.github.com/repositories/${pkg.repoId}/tags`]: (req) =>
      opts.etag && req.headers.get("if-none-match") === opts.etag ? new Response(null, { status: 304 }) : new Response(JSON.stringify(tags.map((name) => ({ name }))), { headers: { etag: opts.etag ?? '"e1"' } }),
    [`GET https://api.github.com/repositories/${pkg.repoId}`]: meta === null ? null : {
      full_name: pkg.path, html_url: `https://github.com/${pkg.path}`, default_branch: "main", description: "desc", topics: ["osint"], stargazers_count: 7, archived: false, private: false, ...meta,
    },
    "GET https://api.github.com/repos/": "# Updated README\n",
    "POST https://api.resend.com/emails": { id: "e" },
  });
}

const searchRefs = async (q: string) => (((await (await call(`/tools?q=${q}`)).json()) as any).results as any[]).map((r) => `${r.namespace}/${r.name}`);

describe("sync", () => {
  it("queues release tags the webhooks missed, once, and refreshes the README", async () => {
    const pkg = await githubPackage();
    fakeGithubRepo(pkg, {}, ["v1.1.0", "v1.0.0", "nightly"]);
    const s = (await sourceById(env as any, pkg.srcId))!;
    expect(await pollSource(await testEnv(), s, "poll")).toEqual({ status: "ok", queued: ["v1.1.0"] });
    expect(await DB().prepare(`SELECT readme_text FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ readme_text: "# Updated README\n" });
    expect(await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).toEqual({ status: "ok", queued: [] });
    expect(sent).toHaveLength(1);
  });

  it("skips the tag list when it has not changed", async () => {
    const pkg = await githubPackage();
    fakeGithubRepo(pkg, {}, ["v2.0.0"], { etag: '"same"' });
    await DB().prepare(`UPDATE sources SET etag = '"same"' WHERE id = ?`).bind(pkg.srcId).run();
    expect(await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).toEqual({ status: "ok", queued: [] });
  });

  it("deprecates the package when the repository is archived, and undoes it on unarchive", async () => {
    const pkg = await githubPackage();
    const calls = fakeGithubRepo(pkg, { archived: true });
    await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll");
    expect(await DB().prepare(`SELECT status, deprecated_message FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ status: "deprecated" });
    expect(calls.some((c) => c.url === "https://api.resend.com/emails")).toBe(true);
    fakeGithubRepo(pkg, { archived: false });
    await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll");
    expect(await DB().prepare(`SELECT status FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ status: "active" });
  });

  it("hides a package whose repository disappears, keeps it installable, and restores it", async () => {
    const pkg = await githubPackage();
    expect(await searchRefs(pkg.login)).toContain(`${pkg.login}/scraper`);
    fakeGithubRepo(pkg, null);
    expect((await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).status).toBe("unavailable");
    expect(await searchRefs(pkg.login)).not.toContain(`${pkg.login}/scraper`);
    const m = (await (await call(`/tools/${pkg.login}/scraper/latest/manifest`)).json()) as any;
    expect(m.source_unavailable).toBe(true);
    fakeGithubRepo(pkg, {});
    expect((await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).status).toBe("ok");
    expect(await searchRefs(pkg.login)).toContain(`${pkg.login}/scraper`);
  });

  it("follows renames, but waits for confirmation when the owner changes", async () => {
    const pkg = await githubPackage();
    fakeGithubRepo(pkg, { full_name: `${pkg.login}/scraper-v2`, html_url: `https://github.com/${pkg.login}/scraper-v2` });
    await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll");
    expect(await DB().prepare(`SELECT repo_url FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ repo_url: `https://github.com/${pkg.login}/scraper-v2` });
    fakeGithubRepo(pkg, { full_name: `someone-else/scraper-v2` });
    expect((await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).status).toBe("transfer_pending");
  });

  it("pauses sync and tells the owner when access is lost", async () => {
    const pkg = await githubPackage();
    const calls = fakeHosts({ "POST https://api.github.com/app/installations/": new Response("gone", { status: 401 }), "POST https://api.resend.com/emails": { id: "e" } });
    expect((await pollSource(await testEnv(), (await sourceById(env as any, pkg.srcId))!, "poll")).status).toBe("paused");
    expect(calls.some((c) => c.url === "https://api.resend.com/emails")).toBe(true);
    expect(await DB().prepare(`SELECT sync_status FROM sources WHERE id = ?`).bind(pkg.srcId).first()).toMatchObject({ sync_status: "paused" });
  });

  it("polls only sources that are due", async () => {
    const pkg = await githubPackage();
    await DB().prepare(`UPDATE sources SET last_poll_at = ? WHERE sync_status IN ('ok', 'error', 'unavailable')`).bind(Date.now()).run();
    await DB().prepare(`UPDATE sources SET last_poll_at = 0 WHERE id = ?`).bind(pkg.srcId).run();
    fakeGithubRepo(pkg, {});
    expect(await pollDueSources(await testEnv())).toBe(1);
  });

  it("applies GitHub repository and release events as they happen", async () => {
    const pkg = await githubPackage();
    fakeGithubRepo(pkg, {});
    const repo = { id: Number(pkg.repoId), full_name: pkg.path, html_url: `https://github.com/${pkg.path}`, default_branch: "main", archived: true, private: false };
    await webhook("repository", { action: "archived", repository: repo, installation: { id: 4242 } });
    expect(await DB().prepare(`SELECT status FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ status: "deprecated" });
    await webhook("release", { action: "published", release: { tag_name: "v1.0.0", body: "First release" }, repository: repo, installation: { id: 4242 } });
    expect(await DB().prepare(`SELECT changelog FROM versions WHERE tool_id = ?`).bind(pkg.toolId).first()).toMatchObject({ changelog: "First release" });
    await webhook("push", { ref: "refs/heads/main", repository: { ...repo, archived: false }, installation: { id: 4242 } });
    expect(await DB().prepare(`SELECT status, readme_text FROM tools WHERE id = ?`).bind(pkg.toolId).first()).toMatchObject({ status: "active", readme_text: "# Updated README\n" });
  });

  it("lets owners sync by hand (rate-limited) and read the sync log", async () => {
    const pkg = await githubPackage();
    fakeGithubRepo(pkg, {});
    const outsider = await gitlabUser();
    expect((await call(`/packages/${pkg.login}/scraper/sync`, { method: "POST", headers: outsider.auth })).status).toBe(403);
    for (let i = 0; i < 10; i++) expect((await call(`/packages/${pkg.login}/scraper/sync`, { method: "POST", headers: pkg.auth })).status).toBe(200);
    expect((await call(`/packages/${pkg.login}/scraper/sync`, { method: "POST", headers: pkg.auth })).status).toBe(429);
    const log = (await (await call(`/packages/${pkg.login}/scraper/sync-log`, { headers: pkg.auth })).json()) as any;
    expect(log.source).toMatchObject({ provider: "github", sync_status: "ok" });
    expect(log.events.filter((e: any) => e.kind === "manual")).toHaveLength(10);
  });
});

describe("sync before a package's first release", () => {
  const tagList = (tags: string[]) => tags.map((name) => ({ name }));
  async function connectedWith(tagsAtConnect: string[] | null) {
    const user = await gitlabUser();
    const p = project(Number(uniq()), `${user.login}/early`);
    const { body } = await connect(user, p, tagsAtConnect ? { [`GET ${GL}${p.id}/repository/tags`]: tagList(tagsAtConnect) } : {});
    return { p, sourceId: body.source_id as string };
  }
  async function poll(c: Awaited<ReturnType<typeof connectedWith>>, tags: string[]) {
    fakeHosts({ [`GET ${GL}${c.p.id}/repository/tags`]: tagList(tags), [`GET ${GL}${c.p.id}`]: c.p });
    return pollSource(await testEnv(), (await sourceById(env as any, c.sourceId))!, "poll");
  }
  const jobs = async (sourceId: string) =>
    (await DB().prepare(`SELECT tag FROM publish_jobs WHERE source_id = ? ORDER BY tag`).bind(sourceId).all<{ tag: string }>()).results.map((r) => r.tag);

  it("never backfills tags that existed when the project was connected", async () => {
    const c = await connectedWith(["v0.2.0", "v0.1.0", "nightly"]);
    expect(await DB().prepare(`SELECT baseline_tags FROM sources WHERE id = ?`).bind(c.sourceId).first()).toEqual({ baseline_tags: '["v0.2.0","v0.1.0"]' });
    expect(await poll(c, ["v0.2.0", "v0.1.0"])).toEqual({ status: "ok", queued: [] });
    expect(await poll(c, ["v0.3.0", "v0.2.0", "v0.1.0"])).toEqual({ status: "ok", queued: ["v0.3.0"] });
    expect(await jobs(c.sourceId)).toEqual(["v0.3.0"]);
  });

  it("records the existing tags on the first poll when they could not be listed at connect time", async () => {
    const c = await connectedWith(null);
    expect(await DB().prepare(`SELECT baseline_tags FROM sources WHERE id = ?`).bind(c.sourceId).first()).toEqual({ baseline_tags: null });
    expect(await poll(c, ["v0.2.0", "v0.1.0"])).toEqual({ status: "ok", queued: [] });
    expect(await poll(c, ["v1.0.0", "v0.2.0", "v0.1.0"])).toEqual({ status: "ok", queued: ["v1.0.0"] });
    expect(await jobs(c.sourceId)).toEqual(["v1.0.0"]);
  });

  it("keeps old tags out after the first release too", async () => {
    const c = await connectedWith(["v0.1.0"]);
    const pkg = await githubPackage();
    // The package's first release moves its tool onto this source.
    await DB().batch([
      DB().prepare(`UPDATE sources SET tool_id = NULL WHERE id = ?`).bind(pkg.srcId),
      DB().prepare(`UPDATE sources SET tool_id = ? WHERE id = ?`).bind(pkg.toolId, c.sourceId),
    ]);
    expect((await poll(c, ["v1.1.0", "v0.1.0"])).queued).toEqual(["v1.1.0"]);
  });

  it("still backfills existing tags for a registry-held manifest", async () => {
    const c = await connectedWith(["v0.2.0", "v0.1.0"]);
    await DB().prepare(`UPDATE sources SET manifest_mode = 'registry', registry_manifest_json = '{}' WHERE id = ?`).bind(c.sourceId).run();
    expect(await poll(c, ["v0.2.0", "v0.1.0"])).toEqual({ status: "ok", queued: ["v0.2.0", "v0.1.0"] });
  });
});
