// The upstream watcher: the Dockerfile pin parser (every community wrapper in the seed names the upstream release it
// builds), comparing release names, and checks against fake GitHub and PyPI in report and issues mode.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findPin } from "../src/upstream-pin";
import { checkUpstream, compareVersions, queueUpstreamChecks } from "../src/upstream";
import { pinOnly, sweepBumps, upstreamSemver, wrapperVersion } from "../src/bumps";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, sent, testEnv } from "./helpers";

type Wrapper = { name: string; homepage: string; dockerfile: string };
const WRAPPERS = (env as unknown as { TEST_DOCKERFILES: Wrapper[] }).TEST_DOCKERFILES;

describe("upstream pins", () => {
  it("finds the upstream pin in every seed wrapper's Dockerfile", () => {
    expect(WRAPPERS.length).toBeGreaterThan(50);
    const missing = WRAPPERS.filter((w) => !findPin(w.dockerfile, w.homepage)).map((w) => w.name);
    expect(missing).toEqual([]);
  });

  it("reads each way of pinning", () => {
    const up = "https://github.com/owner/tool";
    expect(findPin("FROM golang:1.26-alpine AS b\nRUN go install -trimpath github.com/owner/tool/v2/cmd/tool@v2.3.1\n", up)).toMatchObject({ kind: "go", ref: "v2.3.1", line: 2 });
    expect(findPin("FROM python:3.12-slim\nRUN pip install --no-cache-dir \"Tool==1.4\" \"requests==2.0\"\n", up)).toMatchObject({ kind: "pip", ref: "1.4", package: "Tool" });
    expect(findPin("FROM python:3.12-slim\nRUN pip install git+https://github.com/owner/tool@0123456789abcdef0123456789abcdef01234567\n", up)).toMatchObject({ kind: "pip_git", ref: "0123456789abcdef0123456789abcdef01234567" });
    expect(findPin("FROM alpine:3.22\nRUN git clone --quiet https://github.com/owner/tool.git /src && \\n  git -C /src checkout --quiet v1.0\n", up)).toMatchObject({ kind: "git", ref: "v1.0", line: 2 });
    expect(findPin("FROM rust:1.90-slim\nRUN cargo install --locked --git https://github.com/owner/tool --tag 10.0.1 tool\n", up)).toMatchObject({ kind: "cargo_git", ref: "10.0.1" });
    expect(findPin("FROM alpine:3.22\nARG UPSTREAM_VERSION=1.2.3\nRUN go install github.com/owner/tool@v${UPSTREAM_VERSION}\n", up)).toMatchObject({ kind: "arg", ref: "1.2.3", line: 2 });
    expect(findPin("FROM alpine:3.22\nRUN curl -fsSLo /t.tgz https://github.com/owner/tool/releases/download/v2.11.0/tool_linux.tgz\n", up)).toMatchObject({ kind: "release_url", ref: "v2.11.0" });
    // Another project's pin is not the upstream's.
    expect(findPin("FROM golang:1.26-alpine\nRUN go install github.com/someone/else@v1.0.0\n", up)).toBeNull();
  });
});

// ---------- the watcher ----------

const GH = "https://api.github.com";
const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;
const DAY = 86_400_000;

/** A published community wrapper of `upstream` whose latest version was built from `dockerfile` (or pins a wheel). */
async function wrapper(upstream: string, opts: { dockerfile?: string; pipx?: { package: string; version: string } } = {}) {
  const name = `w${uniq()}`;
  const toolId = ulid();
  const versionId = ulid();
  const sha = `sha${uniq()}`;
  const manifest = opts.pipx
    ? { version: "1.0.0", homepage: `https://github.com/${upstream}`, runtime: { kind: "pipx", package: opts.pipx.package, package_version: opts.pipx.version } }
    : { version: "1.2.0", homepage: `https://github.com/${upstream}`, runtime: { kind: "docker", image: `ghcr.io/osintverse-community/${name}@sha256:${"a".repeat(64)}` } };
  await DB().batch([
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, community_packaged, repo_url, upstream_url, created_at, updated_at) VALUES (?, 'ns_community', 'tool', ?, 'x', 1, ?, ?, 1, 1)`)
      .bind(toolId, name, `https://github.com/osintverse-community/${name}`, `https://github.com/${upstream}`),
    DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, git_sha, status, published_at, created_at) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, 'published', 1, 1)`)
      .bind(versionId, toolId, manifest.version, JSON.stringify(manifest), manifest.runtime.kind, sha),
    DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(versionId, toolId),
    DB().prepare(`INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url) VALUES (?, ?, 'ns_community', 'github', ?, ?, ?)`)
      .bind(ulid(), toolId, uniq(), `osintverse-community/${name}`, `https://github.com/osintverse-community/${name}`),
  ]);
  return { name, toolId, sha, ref: `osintverse-community/${name}` };
}

/** GitHub for one upstream repository and the wrapper's Dockerfile, counting calls. */
function github(upstream: string, w: { name: string }, over: { repo?: Record<string, unknown>; release?: Response | object | null; dockerfile?: string; compare?: object } = {}) {
  return fakeHosts({
    [`POST ${GH}/app/installations/`]: { token: "ghs_x" },
    [`GET ${GH}/repos/${upstream}`]: { full_name: upstream, archived: false, default_branch: "main", license: { spdx_id: "MIT" }, ...over.repo },
    [`GET ${GH}/repos/${upstream}/releases/latest`]: over.release === undefined
      ? new Response(JSON.stringify({ tag_name: "v1.3.0", published_at: new Date(Date.now() - 10 * DAY).toISOString() }), { headers: { etag: 'W/"r1"', "content-type": "application/json" } })
      : over.release,
    [`GET ${GH}/repos/${upstream}/compare/`]: over.compare ?? { ahead_by: 0, commits: [] },
    [`GET ${GH}/repos/osintverse-community/${w.name}/contents/Dockerfile`]: over.dockerfile ?? null,
  });
}

const go = (upstream: string, v: string) => `FROM golang:1.26-alpine AS b\nRUN go install github.com/${upstream}@${v}\nFROM alpine:3.22\nUSER 65534\n`;

async function installation() {
  await DB().prepare(
    `INSERT INTO installations (id, github_installation_id, namespace_id, repo_ids, account_login, account_type, repository_selection) VALUES (?, ?, 'ns_community', '[]', 'osintverse-community', 'Organization', 'all')`,
  ).bind(ulid(), Number(uniq())).run();
}

describe("upstream watcher", () => {
  it("compares release names", () => {
    expect(compareVersions("v1.2.0", "1.3.0")).toBe(-1);
    expect(compareVersions("1.10", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-rc1", "2.0.0")).toBe(-1);
    expect(compareVersions("v3.1.0", "3.1.0")).toBe(0);
    expect(compareVersions("latest", "1.0")).toBeNull();
  });

  it("reports a wrapper behind its upstream, reading the Dockerfile only when the version changes", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const calls = github(upstream, w, { dockerfile: go(upstream, "v1.2.0") });
    const e = await testEnv();
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "behind", pin_kind: "go", pinned: "v1.2.0", latest: "v1.3.0", releases_etag: 'W/"r1"' });
    expect(calls.filter((c) => c.url.includes("/contents/Dockerfile"))).toHaveLength(1);
    // Report mode files no issue.
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ n: 0 });

    // Next night: the release answer is a 304 and the Dockerfile isn't read again.
    const again = github(upstream, w, { dockerfile: go(upstream, "v1.2.0"), release: new Response(null, { status: 304 }) });
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "behind", latest: "v1.3.0" });
    expect(again.find((c) => c.url.endsWith("/releases/latest"))).toBeTruthy();
    expect(again.some((c) => c.url.includes("/contents/Dockerfile"))).toBe(false);

    // The tool page and the public summary show it.
    const tool = (await (await call(`/tools/${w.ref}`)).json()) as any;
    expect(tool.upstream).toMatchObject({ state: "behind", pinned: "v1.2.0", latest: "v1.3.0" });
    const summary = await call("/upstream/summary");
    expect(summary.headers.get("cache-control")).toMatch(/public/);
    const body = (await summary.json()) as any;
    expect(body.mode).toBe("report");
    expect(body.behind.some((b: any) => b.ref === w.ref)).toBe(true);
  });

  it("opens an outdated issue in issues mode, and closes it once a published pin catches up", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    github(upstream, w, { dockerfile: go(upstream, "v1.2.0") });
    const e = { ...(await testEnv()), UPSTREAM_WATCH: "issues" };
    await checkUpstream(e, w.toolId);
    const issue = await DB().prepare(`SELECT number, kind, title, status, author_kind FROM issues WHERE tool_id = ? AND dedupe_key = 'outdated:v1.3.0'`).bind(w.toolId).first<any>();
    expect(issue).toMatchObject({ kind: "outdated", title: "Upstream released v1.3.0", status: "open", author_kind: "system" });
    // Checking again doesn't open a second one.
    await checkUpstream(e, w.toolId);
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ n: 1 });

    // A new version pinning v1.3.0 is published.
    const v2 = ulid();
    await DB().batch([
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, git_sha, status, published_at, created_at) VALUES (?, ?, '1.3.0', 1, 3, 0, ?, 'docker', 'sha2', 'published', 2, 2)`)
        .bind(v2, w.toolId, JSON.stringify({ version: "1.3.0", runtime: { kind: "docker", image: `ghcr.io/osintverse-community/${w.name}@sha256:${"b".repeat(64)}` } })),
      DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(v2, w.toolId),
    ]);
    github(upstream, w, { dockerfile: go(upstream, "v1.3.0") });
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "current", pinned: "v1.3.0" });
    expect(await DB().prepare(`SELECT status FROM issues WHERE tool_id = ? AND number = ?`).bind(w.toolId, issue.number).first()).toEqual({ status: "fixed" });
  });

  it("waits three days after a release before opening an issue", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    github(upstream, w, { dockerfile: go(upstream, "v1.2.0"), release: { tag_name: "v1.3.0", published_at: new Date(Date.now() - DAY).toISOString() } });
    await checkUpstream({ ...(await testEnv()), UPSTREAM_WATCH: "issues" }, w.toolId);
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ n: 0 });
  });

  it("notices an archived or relicensed upstream, and says so in issues mode", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    github(upstream, w, { repo: { archived: true } });
    const e = { ...(await testEnv()), UPSTREAM_WATCH: "issues" };
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "archived" });
    expect(await DB().prepare(`SELECT title FROM issues WHERE tool_id = ? AND dedupe_key = 'upstream:archived'`).bind(w.toolId).first()).toEqual({ title: "The upstream repository was archived" });
    github(upstream, w, { repo: { license: { spdx_id: "BUSL-1.1" } } });
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "license_changed", upstream_license: "BUSL-1.1" });
    github(upstream, w, { repo: { full_name: `${upstream}-ng` } });
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "renamed" });
    fakeHosts({ [`POST ${GH}/app/installations/`]: { token: "ghs_x" }, [`GET ${GH}/repos/${upstream}`]: null });
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "gone" });
  });

  it("checks wheels on PyPI and commit pins with the compare API", async () => {
    await installation();
    const upstream = `up${uniq()}/py`;
    const w = await wrapper(upstream, { pipx: { package: "py-tool", version: "1.0" } });
    fakeHosts({
      [`POST ${GH}/app/installations/`]: { token: "ghs_x" },
      [`GET ${GH}/repos/${upstream}`]: { full_name: upstream, archived: false, default_branch: "main", license: { spdx_id: "MIT" } },
      "GET https://pypi.org/pypi/py-tool/json": { info: { version: "1.1" }, releases: { "1.1": [{ upload_time_iso_8601: "2026-10-01T00:00:00Z" }] } },
    });
    expect(await checkUpstream(await testEnv(), w.toolId)).toMatchObject({ state: "behind", pin_kind: "pipx", pinned: "1.0", latest: "1.1", latest_at: Date.parse("2026-10-01T00:00:00Z") });

    const up2 = `up${uniq()}/git`;
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const w2 = await wrapper(up2);
    github(up2, w2, { dockerfile: `FROM python:3.12-slim\nRUN pip install git+https://github.com/${up2}@${sha}\nUSER 65534\n`, compare: { ahead_by: 5, commits: [{ commit: { committer: { date: "2026-10-20T00:00:00Z" } } }] } });
    expect(await checkUpstream({ ...(await testEnv()), UPSTREAM_WATCH: "issues" }, w2.toolId)).toMatchObject({ state: "behind", pin_kind: "pip_git", commits_behind: 5 });
    // Commits on a branch aren't a release: no outdated issue for them.
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ?`).bind(w2.toolId).first()).toEqual({ n: 0 });
  });

  it("lets staff override a pin the Dockerfile doesn't show, and queues every wrapper nightly", async () => {
    await installation();
    const upstream = `up${uniq()}/odd`;
    const w = await wrapper(upstream);
    github(upstream, w, { dockerfile: "FROM alpine:3.22\nRUN apk add something\nUSER 65534\n" });
    expect(await checkUpstream(await testEnv(), w.toolId)).toMatchObject({ state: "unknown", pin_kind: "none" });
    const admin = ulid();
    const token = `ot_test_${admin}`;
    await DB().batch([
      DB().prepare(`INSERT INTO users (id, login, is_admin, created_at) VALUES (?, ?, 1, 1)`).bind(admin, `adm${uniq()}`),
      DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, 1)`).bind(ulid(), admin, await sha256Hex(token)),
    ]);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    github(upstream, w, {});
    const res = await call(`/admin/upstream/${w.ref}`, { method: "PUT", headers, body: JSON.stringify({ pinned: "1.3.0", pin_kind: "release" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).watch).toMatchObject({ state: "current", pinned: "1.3.0" });
    const list = (await (await call("/admin/upstream?state=current", { headers })).json()) as any;
    expect(list.watches.find((x: any) => x.ref === w.ref)).toMatchObject({ override: { pin_kind: "release", pinned: "1.3.0" } });
    expect((await call(`/admin/upstream/${w.ref}`, { method: "PUT", headers: {}, body: "{}" })).status).toBe(401);

    sent.length = 0;
    expect(await queueUpstreamChecks(await testEnv())).toBeGreaterThan(0);
  });
});

// ---------- bump pull requests ----------

describe("bump pull requests", () => {
  /** The community bot on the wrapper repository: its files, the pull request it opens, merges, tags and dispatches. */
  function bot(upstream: string, w: { name: string }, files: Record<string, string>, extra: Record<string, any> = {}) {
    const repo = `osintverse-community/${w.name}`;
    const commits: { path: string; content: string; branch: string }[] = [];
    const did: { pulls: unknown[]; merged: unknown[]; dispatched: unknown[]; tagged: unknown[] } = { pulls: [], merged: [], dispatched: [], tagged: [] };
    const calls = fakeHosts({
      [`POST ${GH}/app/installations/`]: { token: "ghs_x" },
      [`GET ${GH}/repos/${upstream}`]: { full_name: upstream, archived: false, default_branch: "main", license: { spdx_id: "MIT" } },
      [`GET ${GH}/repos/${upstream}/releases/latest`]: { tag_name: "v1.3.0", published_at: new Date(Date.now() - 10 * DAY).toISOString() },
      [`GET ${GH}/repos/${repo}/contents/`]: (req: Request) => {
        const path = decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!);
        // A bump branch holds what the bot committed to it.
        const ref = new URL(req.url).searchParams.get("ref") ?? "";
        const onBranch = commits.filter((c) => c.branch === ref && c.path === path).at(-1);
        if (onBranch) return (req.headers.get("accept") ?? "").includes("raw") ? new Response(onBranch.content) : { sha: "new", type: "file" };
        if (files[path] === undefined) return null;
        return (req.headers.get("accept") ?? "").includes("raw") ? new Response(files[path]) : { sha: "old", type: "file" };
      },
      [`PUT ${GH}/repos/${repo}/contents/`]: async (req: Request) => {
        const b = (await req.json()) as { content: string; branch: string };
        commits.push({ path: decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!), branch: b.branch, content: atob(b.content) });
        return new Response("{}", { status: 201 });
      },
      [`GET ${GH}/repos/${repo}/git/ref/heads/main`]: { object: { sha: "base123" } },
      [`POST ${GH}/repos/${repo}/git/refs`]: async (req: Request) => {
        const b = (await req.json()) as { ref: string };
        if (b.ref.startsWith("refs/tags/")) did.tagged.push(b);
        return new Response("{}", { status: 201 });
      },
      [`POST ${GH}/repos/${repo}/pulls`]: async (req: Request) => (did.pulls.push(await req.json()), { html_url: `https://github.com/${repo}/pull/9`, number: 9 }),
      [`GET ${GH}/repos/${repo}/pulls/9/files`]: [{ filename: "Dockerfile", status: "modified", changes: 2, patch: "@@ -1,2 +1,2 @@\n FROM golang:1.26-alpine AS b\n-RUN go install x@v1.2.0\n+RUN go install x@v1.3.0" }],
      [`PUT ${GH}/repos/${repo}/pulls/9/merge`]: async (req: Request) => (did.merged.push(await req.json()), { sha: "merged456", merged: true }),
      [`POST ${GH}/repos/${repo}/actions/workflows/`]: async (req: Request) => (did.dispatched.push(await req.json()), new Response(null, { status: 204 })),
      "GET https://pypi.org/pypi/": { info: { version: "1.3.0" }, urls: [{ packagetype: "bdist_wheel", filename: "x-1.3.0-py3-none-any.whl", digests: { sha256: "d".repeat(64) } }] },
      ...extra,
    });
    return { commits, did, calls, files };
  }

  async function botEnv() {
    const base = await testEnv();
    return { ...base, UPSTREAM_WATCH: "prs", COMMUNITY_APP_ID: "77", COMMUNITY_INSTALLATION_ID: "555", COMMUNITY_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY };
  }

  async function person(opts: { reviewer?: boolean } = {}) {
    const id = ulid();
    const token = `ot_test_${id}`;
    await DB().batch([
      DB().prepare(`INSERT INTO users (id, login, handle, is_reviewer, created_at) VALUES (?, ?, ?, ?, 1)`).bind(id, `m${uniq()}`, `m${uniq()}`, opts.reviewer ? 1 : 0),
      DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, 1)`).bind(ulid(), id, await sha256Hex(token)),
    ]);
    return { id, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
  }

  it("opens a pull request changing only the pin, and a maintainer merges and releases it", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const dockerfile = go(upstream, "v1.2.0");
    const b = bot(upstream, w, { Dockerfile: dockerfile });
    const e = await botEnv();
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "behind" });
    expect(b.commits).toEqual([{ path: "Dockerfile", branch: "otinstaller/bump-1.3.0", content: dockerfile.replace("@v1.2.0", "@v1.3.0") }]);
    expect(b.did.pulls[0]).toMatchObject({ title: `Bump ${w.name} to v1.3.0`, head: "otinstaller/bump-1.3.0", base: "main" });
    expect(await DB().prepare(`SELECT version, pr_number, status FROM bump_prs WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ version: "v1.3.0", pr_number: 9, status: "open" });
    const issue = await DB().prepare(`SELECT body_md FROM issues WHERE tool_id = ? AND dedupe_key = 'outdated:v1.3.0'`).bind(w.toolId).first<{ body_md: string }>();
    expect(issue!.body_md).toContain(`https://github.com/osintverse-community/${w.name}/pull/9`);
    // Checking again opens no second pull request.
    await checkUpstream(e, w.toolId);
    expect(b.did.pulls).toHaveLength(1);
    expect(((await (await call(`/tools/${w.ref}`, {}, e)).json()) as any).upstream.bump).toEqual({ kind: "upstream", version: "v1.3.0", number: 9, url: `https://github.com/osintverse-community/${w.name}/pull/9`, status: "open" });

    // Someone unrelated can't release it; a maintainer of the package can.
    const stranger = await person();
    const nope = await call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: stranger.headers, body: "{}" }, e);
    expect(((await nope.json()) as any).error.code).toBe("not_package_maintainer");
    const maintainer = await person();
    await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'submitter', 1)`).bind(w.toolId, maintainer.id).run();
    expect(((await (await call(`/packages/${w.ref}/bump`, { headers: maintainer.headers }, e)).json()) as any)).toMatchObject({ can_release: true, bump: { number: 9 } });
    const res = await call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: maintainer.headers, body: "{}" }, e);
    expect(await res.json()).toEqual({ merged: true, upstream_version: "v1.3.0", version: "1.3.0", attempt: 1 });
    expect(b.did.merged).toHaveLength(1);
    expect(b.did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.3.0" } }]);
    expect(await DB().prepare(`SELECT status, released_version, merge_sha, attempts FROM bump_prs WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ status: "merged", released_version: "1.3.0", merge_sha: "merged456", attempts: 1 });
    // The package's maintainers triage its issues too.
    const viewer = await call(`/tools/${w.ref}/issues/1/viewer`, { headers: maintainer.headers }, e);
    expect(viewer.status).toBe(200);
    expect(((await viewer.json()) as any).can_triage).toBe(true);
  });

  it("leaves a pull request that changes more than the pin to a reviewer", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const extra = { [`GET ${GH}/repos/osintverse-community/${w.name}/pulls/9/files`]: [{ filename: "Dockerfile", changes: 4, patch: "-USER 65534\n+USER root\n-RUN go install x@v1.2.0\n+RUN go install x@v1.3.0" }] };
    bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, extra);
    const e = await botEnv();
    await checkUpstream(e, w.toolId);
    const maintainer = await person();
    await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'added', 1)`).bind(w.toolId, maintainer.id).run();
    expect(((await (await call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: maintainer.headers, body: "{}" }, e)).json()) as any).error.code).toBe("not_pin_only");
    const reviewer = await person({ reviewer: true });
    expect((await call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: reviewer.headers, body: "{}" }, e)).status).toBe(200);
  });

  it("bumps a wheel's version and hash in the manifest, and releases it with a tag", async () => {
    await installation();
    const upstream = `up${uniq()}/py`;
    const w = await wrapper(upstream, { pipx: { package: "py-tool", version: "1.2.0" } });
    const yaml = `schema: 1\nname: ${w.name}\nversion: 1.2.0\nruntime:\n  kind: pipx\n  package: py-tool\n  package_version: "1.2.0"\n  wheel_sha256: ${"c".repeat(64)}\n`;
    const b = bot(upstream, w, { "otinstaller.yaml": yaml }, {
      "GET https://pypi.org/pypi/py-tool/json": { info: { version: "1.3.0" }, releases: { "1.3.0": [{ upload_time_iso_8601: new Date(Date.now() - 10 * DAY).toISOString() }] } },
      [`GET ${GH}/repos/osintverse-community/${w.name}/pulls/9/files`]: [{ filename: "otinstaller.yaml", changes: 6, patch: "-version: 1.2.0\n+version: 1.3.0\n-  package_version: \"1.2.0\"\n+  package_version: \"1.3.0\"\n-  wheel_sha256: c\n+  wheel_sha256: d" }],
    });
    const e = await botEnv();
    expect(await checkUpstream(e, w.toolId)).toMatchObject({ state: "behind", pin_kind: "pipx", latest: "1.3.0" });
    expect(b.commits[0]!.content).toBe(yaml.replace("version: 1.2.0", "version: 1.3.0").replace('package_version: "1.2.0"', 'package_version: "1.3.0"').replace("c".repeat(64), "d".repeat(64)));
    const reviewer = await person({ reviewer: true });
    // Merging puts the bumped manifest on main.
    b.files["otinstaller.yaml"] = b.commits[0]!.content;
    expect(await (await call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: reviewer.headers, body: "{}" }, e)).json()).toMatchObject({ version: "1.3.0" });
    expect(b.did.tagged).toEqual([{ ref: "refs/tags/v1.3.0", sha: "merged456" }]);
  });

  it("knows a pin-only change when it sees one", () => {
    expect(pinOnly([{ filename: "Dockerfile", patch: "@@ -2 +2 @@\n-RUN go install x@v1\n+RUN go install x@v2" }])).toBe(true);
    expect(pinOnly([{ filename: "Dockerfile", patch: "-a\n+b\n-c\n+d" }])).toBe(false);
    expect(pinOnly([{ filename: "README.md", patch: "-a\n+b" }])).toBe(false);
    expect(pinOnly([{ filename: "otinstaller.yaml", patch: "-version: 1\n+version: 2\n-  wheel_sha256: a\n+  wheel_sha256: b" }])).toBe(true);
    expect(pinOnly([{ filename: "otinstaller.yaml", patch: "-  command: [a]\n+  command: [b]" }])).toBe(false);
  });
  it("turns upstream's release into a version above every one the package had", async () => {
    expect(upstreamSemver("v1.62")).toBe("1.62.0");
    expect(upstreamSemver("2.2")).toBe("2.2.0");
    expect(upstreamSemver("20250130")).toBe("20250130.0.0");
    expect(upstreamSemver("2026.08.19")).toBe("2026.8.19");
    expect(upstreamSemver("1.2.3.4")).toBe("1.2.3");
    expect(upstreamSemver("0.45.post1")).toBe("0.45.0");
    for (const pre of ["2.0.0-rc1", "1.3.0b2", "v2.0.0-beta", "latest", "main (3 commits on)"]) expect(upstreamSemver(pre)).toBeNull();
    const w = await wrapper(`up${uniq()}/tool`);
    const e = await testEnv();
    expect(await wrapperVersion(e, w.toolId, "v1.62")).toBe("1.62.0");
    // Not above 1.2.0, the package's own version: a patch on top.
    expect(await wrapperVersion(e, w.toolId, "1.2")).toBe("1.2.1");
    expect(await wrapperVersion(e, w.toolId, "1.2.0.1")).toBe("1.2.1");
    expect(await wrapperVersion(e, w.toolId, "3.0.0-rc1")).toBeNull();
  });

  it("follows a release to the end: published closes the issue, a failure tells the maintainers and can be released again", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const repo = `osintverse-community/${w.name}`;
    let dispatchFails = false;
    let runs: object[] = [];
    const b = bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, {
      [`POST ${GH}/repos/${repo}/actions/workflows/`]: async (req: Request) => {
        if (dispatchFails) return new Response("boom", { status: 500 });
        return (b.did.dispatched.push(await req.json()), new Response(null, { status: 204 }));
      },
      [`GET ${GH}/repos/${repo}/actions/workflows/`]: () => ({ workflow_runs: runs }),
    });
    const e = await botEnv();
    await checkUpstream(e, w.toolId);
    const maintainer = await person();
    await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'submitter', 1)`).bind(w.toolId, maintainer.id).run();
    const release = () => call(`/packages/${w.ref}/pulls/9/release`, { method: "POST", headers: maintainer.headers, body: "{}" }, e);
    const row = () => DB().prepare(`SELECT status, released_version, error_code, run_url, attempts FROM bump_prs WHERE tool_id = ?`).bind(w.toolId).first<any>();
    const inbox = async () => (await DB().prepare(`SELECT summary FROM inbox WHERE user_id = ? AND tool_id = ?`).bind(maintainer.id, w.toolId).all<{ summary: string }>()).results;

    // The dispatch fails after the merge: the bump is failed, not stuck, and says so.
    dispatchFails = true;
    const broken = await release();
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as any).error.code).toBe("github_failed");
    expect(await row()).toMatchObject({ status: "failed", error_code: "release_start_failed", attempts: 1 });
    expect(b.did.merged).toHaveLength(1);

    // Released again: no second merge.
    dispatchFails = false;
    expect(await (await release()).json()).toEqual({ merged: true, upstream_version: "v1.3.0", version: "1.3.0", attempt: 2 });
    expect(b.did.merged).toHaveLength(1);
    expect(b.did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.3.0" } }]);
    // A second click while it is being released.
    expect(((await (await release()).json()) as any).error.code).toBe("bump_in_progress");

    // The scan rejects it: failed, and the maintainers hear about it.
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, rejected_reason, created_at) VALUES (?, ?, '1.3.0', 1, 3, 0, '{}', 'rejected', 'smoke_test_failed', 1)`)
      .bind(ulid(), w.toolId).run();
    await sweepBumps(e);
    expect(await row()).toMatchObject({ status: "failed", error_code: "smoke_test_failed" });
    expect((await inbox()).some((i) => i.summary.includes("failed (smoke_test_failed)"))).toBe(true);
    const detail = ((await (await call(`/packages/${w.ref}/bump`, { headers: maintainer.headers }, e)).json()) as any);
    expect(detail.bump).toMatchObject({ status: "failed", error_code: "smoke_test_failed", attempts: 2 });

    // Released again under a new version, since 1.3.0 exists; the build fails on GitHub.
    expect(await (await release()).json()).toMatchObject({ version: "1.3.1", attempt: 3 });
    const started = Date.now();
    runs = [{ status: "completed", conclusion: "failure", html_url: `https://github.com/${repo}/actions/runs/1`, created_at: new Date(started).toISOString() }];
    await sweepBumps(e, started + 31 * 60_000);
    expect(await row()).toMatchObject({ status: "failed", error_code: "release_workflow_failed", run_url: `https://github.com/${repo}/actions/runs/1` });

    // Nothing arrives at all within 12 hours.
    runs = [];
    expect(await (await release()).json()).toMatchObject({ version: "1.3.2", attempt: 4 });
    await sweepBumps(e, Date.now() + 60_000);
    expect((await row()).status).toBe("merged");
    await sweepBumps(e, Date.now() + 13 * 3_600_000);
    expect(await row()).toMatchObject({ status: "failed", error_code: "release_not_received" });

    // The next attempt is published: released, and the outdated issue closes.
    expect(await (await release()).json()).toMatchObject({ version: "1.3.3" });
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.3.3', 1, 3, 3, '{}', 'published', 1, 1)`)
      .bind(ulid(), w.toolId).run();
    await sweepBumps(e);
    expect(await row()).toMatchObject({ status: "released", released_version: "1.3.3" });
    expect(await DB().prepare(`SELECT status FROM issues WHERE tool_id = ? AND dedupe_key = 'outdated:v1.3.0'`).bind(w.toolId).first()).toEqual({ status: "fixed" });
    expect(((await (await call(`/tools/${w.ref}`, {}, e)).json()) as any).upstream.bump).toMatchObject({ status: "released", released_version: "1.3.3" });
  });

  it("closes a superseded bump on GitHub when upstream releases again", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const repo = `osintverse-community/${w.name}`;
    let latest = "v1.3.0";
    let number = 9;
    const closed: unknown[] = [];
    const b = bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, {
      [`GET ${GH}/repos/${upstream}/releases/latest`]: () => ({ tag_name: latest, published_at: new Date(Date.now() - 10 * DAY).toISOString() }),
      [`POST ${GH}/repos/${repo}/pulls`]: async (req: Request) => (b.did.pulls.push(await req.json()), { html_url: `https://github.com/${repo}/pull/${number}`, number }),
      [`PATCH ${GH}/repos/${repo}/pulls/`]: async (req: Request) => (closed.push({ url: req.url, ...((await req.json()) as object) }), {}),
    });
    const e = await botEnv();
    await checkUpstream(e, w.toolId);
    latest = "v1.4.0";
    number = 10;
    await checkUpstream(e, w.toolId);
    expect(closed).toEqual([{ url: `${GH}/repos/${repo}/pulls/9`, state: "closed" }]);
    const rows = (await DB().prepare(`SELECT version, status FROM bump_prs WHERE tool_id = ? ORDER BY version`).bind(w.toolId).all()).results;
    expect(rows).toEqual([{ version: "v1.3.0", status: "closed" }, { version: "v1.4.0", status: "open" }]);
    expect(b.commits.at(-1)!.content).toContain("@v1.4.0");
  });

  it("never bumps to a prerelease", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const b = bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, {
      [`GET ${GH}/repos/${upstream}/releases/latest`]: { tag_name: "v1.3.0-rc1", published_at: new Date(Date.now() - 10 * DAY).toISOString() },
    });
    await checkUpstream(await botEnv(), w.toolId);
    expect(b.did.pulls).toHaveLength(0);
  });

  it("in auto mode releases a pin-only bump on its own a week after upstream's release, unless turned off", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const repo = `osintverse-community/${w.name}`;
    let prState = "open";
    const b = bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, {
      [`GET ${GH}/repos/${repo}/pulls/9`]: () => ({ state: prState, merged: false, head: { ref: "otinstaller/bump-1.3.0" } }),
    });
    const e = { ...(await botEnv()), UPSTREAM_WATCH: "auto" };
    const t0 = Date.now();
    await checkUpstream(e, w.toolId, t0, { nightly: true });
    expect(b.did.pulls).toHaveLength(1);
    // Too early: the pull request opened today, and gets four days.
    expect(b.did.merged).toHaveLength(0);
    const issue = await DB().prepare(`SELECT body_md FROM issues WHERE tool_id = ? AND dedupe_key = 'outdated:v1.3.0'`).bind(w.toolId).first<{ body_md: string }>();
    expect(issue!.body_md).toContain(`goes out automatically on ${new Date(t0 + 4 * DAY).toISOString().slice(0, 10)}`);
    expect(((await (await call(`/tools/${w.ref}`, {}, e)).json()) as any).upstream.bump.auto_release_at).toBe(t0 + 4 * DAY);

    // A staff member's "Check now" never releases.
    await checkUpstream(e, w.toolId, t0 + 5 * DAY);
    expect(b.did.merged).toHaveLength(0);

    // Its maintainers turned it off; a stranger can't turn it back on.
    const maintainer = await person();
    await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'added', 1)`).bind(w.toolId, maintainer.id).run();
    const set = (h: Record<string, string>, enabled: boolean) => call(`/packages/${w.ref}/auto-release`, { method: "PUT", headers: h, body: JSON.stringify({ enabled }) }, e);
    expect(await (await set(maintainer.headers, false)).json()).toEqual({ auto_release: false });
    expect((await set((await person()).headers, true)).status).toBe(403);
    await checkUpstream(e, w.toolId, t0 + 5 * DAY, { nightly: true });
    expect(b.did.merged).toHaveLength(0);
    expect(((await (await call(`/packages/${w.ref}/bump`, { headers: maintainer.headers }, e)).json()) as any)).toMatchObject({ auto_release: false, mode: "auto", bump: { auto_release_at: null } });

    // Back on: it goes out.
    await set(maintainer.headers, true);
    await checkUpstream(e, w.toolId, t0 + 5 * DAY, { nightly: true });
    expect(b.did.merged).toHaveLength(1);
    expect(b.did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.3.0" } }]);
    expect(await DB().prepare(`SELECT status, auto, merged_by FROM bump_prs WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ status: "merged", auto: 1, merged_by: null });
    expect(await DB().prepare(`SELECT actor_kind FROM audit_log WHERE target_id = ? AND action = 'bump.auto_release'`).bind(w.toolId).first()).toEqual({ actor_kind: "system" });
    prState = "closed";
  });

  it("in auto mode leaves a bump a person closed on GitHub, or one that changes more than the pin", async () => {
    await installation();
    const upstream = `up${uniq()}/tool`;
    const w = await wrapper(upstream);
    const repo = `osintverse-community/${w.name}`;
    let prState = "open";
    let files: object[] = [{ filename: "Dockerfile", status: "modified", changes: 4, patch: "-USER 65534\n+USER root\n-RUN go install x@v1.2.0\n+RUN go install x@v1.3.0" }];
    const b = bot(upstream, w, { Dockerfile: go(upstream, "v1.2.0") }, {
      [`GET ${GH}/repos/${repo}/pulls/9`]: () => ({ state: prState, merged: false, head: { ref: "otinstaller/bump-1.3.0" } }),
      [`GET ${GH}/repos/${repo}/pulls/9/files`]: () => files,
    });
    const e = { ...(await botEnv()), UPSTREAM_WATCH: "auto" };
    const t0 = Date.now();
    await checkUpstream(e, w.toolId, t0, { nightly: true });
    await checkUpstream(e, w.toolId, t0 + 5 * DAY, { nightly: true });
    expect(b.did.merged).toHaveLength(0);
    prState = "closed";
    files = [];
    await checkUpstream(e, w.toolId, t0 + 6 * DAY, { nightly: true });
    expect(b.did.merged).toHaveLength(0);
    expect(await DB().prepare(`SELECT status FROM bump_prs WHERE tool_id = ?`).bind(w.toolId).first()).toEqual({ status: "closed" });
  });
});
