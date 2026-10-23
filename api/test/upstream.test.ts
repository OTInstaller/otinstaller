// The upstream watcher: the Dockerfile pin parser (every community wrapper in the seed names the upstream release it
// builds), comparing release names, and checks against fake GitHub and PyPI in report and issues mode.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findPin } from "../src/upstream-pin";
import { checkUpstream, compareVersions, queueUpstreamChecks } from "../src/upstream";
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
