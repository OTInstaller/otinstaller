// The build watcher: a first-party tool's requirements.txt pins against PyPI (issues, the community bot's pull request
// updating them, released and settled like a bump, and released on its own in auto mode), and each build's base image
// on Docker Hub (rebuilds when it changed and the scan found fixable vulnerabilities).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { baseImage, checkBuild, dockerHubRef, parseRequirements, queueBuildChecks } from "../src/build-watch";
import { pinOnly, sweepBumps } from "../src/bumps";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, testEnv } from "./helpers";

const GH = "https://api.github.com";
const DB = () => env.DB;
const DAY = 86_400_000;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

/** A published package in the community namespace with a repository, built from a Dockerfile at `sha`. */
async function tool(opts: { firstParty?: boolean; vuln?: "pass" | "warn" } = {}) {
  const name = `b${uniq()}`;
  const toolId = ulid();
  const versionId = ulid();
  const sha = `sha${uniq()}`;
  const wrapper = opts.firstParty === false;
  const manifest = { version: "1.2.0", runtime: { kind: "docker", image: `ghcr.io/osintverse-community/${name}@sha256:${"a".repeat(64)}` } };
  await DB().batch([
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, community_packaged, repo_url, upstream_url, created_at, updated_at) VALUES (?, 'ns_community', 'tool', ?, 'x', ?, ?, ?, 1, 1)`)
      .bind(toolId, name, wrapper ? 1 : 0, `https://github.com/osintverse-community/${name}`, wrapper ? `https://github.com/up/${name}` : null),
    DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, git_sha, status, published_at, created_at) VALUES (?, ?, '1.2.0', 1, 2, 0, ?, 'docker', ?, 'published', 1, 1)`)
      .bind(versionId, toolId, JSON.stringify(manifest), sha),
    DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(versionId, toolId),
    DB().prepare(`INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url) VALUES (?, ?, 'ns_community', 'github', ?, ?, ?)`)
      .bind(ulid(), toolId, uniq(), `osintverse-community/${name}`, `https://github.com/osintverse-community/${name}`),
    ...(opts.vuln ? [DB().prepare(`INSERT INTO scans (id, version_id, kind, result, ran_at) VALUES (?, ?, 'vuln', ?, 1)`).bind(ulid(), versionId, opts.vuln)] : []),
  ]);
  return { name, toolId, versionId, sha, ref: `osintverse-community/${name}`, repo: `osintverse-community/${name}` };
}

const REQS = "# pinned\ndnspython==2.8.0\nrequests[socks]==2.32.0 ; python_version >= '3.9'\nidna>=3\n";
const DOCKERFILE = "FROM python:3.12-slim\nCOPY requirements.txt /tmp/\nRUN pip install -r /tmp/requirements.txt\n";

type Pypi = Record<string, { version: string; at: number }>;

/** GitHub (the repository's files at any ref, the bot's branch, pull requests and dispatches), PyPI and Docker Hub. */
function hosts(t: { repo: string; sha: string }, o: { pypi?: Pypi; digest?: string; head?: string; firstPr?: number } = {}) {
  const files: Record<string, string> = { "requirements.txt": REQS, Dockerfile: DOCKERFILE };
  const pypi: Pypi = o.pypi ?? { dnspython: { version: "2.9.0", at: Date.now() - 10 * DAY }, requests: { version: "2.32.0", at: Date.now() - 100 * DAY } };
  const commits: { path: string; content: string; branch: string }[] = [];
  const did: { pulls: any[]; closed: number[]; merged: any[]; dispatched: any[] } = { pulls: [], closed: [], merged: [], dispatched: [] };
  let pr = o.firstPr ?? 20;
  const calls = fakeHosts({
    [`POST ${GH}/app/installations/`]: { token: "ghs_x" },
    [`GET ${GH}/repos/${t.repo}/contents/`]: (req: Request) => {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.split("/contents/")[1]!);
      const onBranch = commits.filter((c) => c.branch === url.searchParams.get("ref") && c.path === path).at(-1);
      const content = onBranch?.content ?? files[path];
      if (content === undefined) return null;
      return (req.headers.get("accept") ?? "").includes("raw") ? new Response(content) : { sha: "old", type: "file" };
    },
    [`PUT ${GH}/repos/${t.repo}/contents/`]: async (req: Request) => {
      const b = (await req.json()) as { content: string; branch: string };
      commits.push({ path: decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!), branch: b.branch, content: atob(b.content) });
      return new Response("{}", { status: 201 });
    },
    [`GET ${GH}/repos/${t.repo}/git/ref/heads/main`]: { object: { sha: o.head ?? t.sha } },
    [`POST ${GH}/repos/${t.repo}/git/refs`]: new Response("{}", { status: 201 }),
    [`POST ${GH}/repos/${t.repo}/pulls`]: async (req: Request) => (did.pulls.push(await req.json()), { html_url: `https://github.com/${t.repo}/pull/${++pr}`, number: pr }),
    [`GET ${GH}/repos/${t.repo}/pulls/`]: (req: Request) => {
      if (!new URL(req.url).pathname.endsWith("/files")) return { state: "open", merged: false, head: { ref: "x" } };
      // The pull request changes what the bot last committed to its branch.
      const last = commits.at(-1);
      const before = REQS.split("\n");
      const after = (last?.content ?? REQS).split("\n");
      const patch = before.flatMap((l, i) => (l === after[i] ? [] : [`-${l}`, `+${after[i]}`])).join("\n");
      return [{ filename: "requirements.txt", status: "modified", changes: 2, patch: `@@ -1 +1 @@\n${patch}` }];
    },
    [`PATCH ${GH}/repos/${t.repo}/pulls/`]: (req: Request) => (did.closed.push(Number(new URL(req.url).pathname.split("/pulls/")[1])), { state: "closed" }),
    [`PUT ${GH}/repos/${t.repo}/pulls/`]: async (req: Request) => (did.merged.push(await req.json()), { sha: "merged789", merged: true }),
    [`POST ${GH}/repos/${t.repo}/actions/workflows/`]: async (req: Request) => (did.dispatched.push(await req.json()), new Response(null, { status: 204 })),
    "GET https://pypi.org/pypi/": (req: Request) => {
      const pkg = decodeURIComponent(new URL(req.url).pathname.split("/")[2]!);
      const p = pypi[pkg];
      return p ? { info: { version: p.version }, releases: { [p.version]: [{ upload_time_iso_8601: new Date(p.at).toISOString() }] } } : null;
    },
    "GET https://auth.docker.io/token": { token: "hub" },
    "HEAD https://registry-1.docker.io/v2/": () => new Response(null, { headers: { "docker-content-digest": o.digest ?? `sha256:${"1".repeat(64)}` } }),
  });
  return { calls, commits, did };
}

async function botEnv(mode: string, extra: Record<string, string> = {}) {
  const base = await testEnv();
  return { ...base, UPSTREAM_WATCH: mode, COMMUNITY_APP_ID: "77", COMMUNITY_INSTALLATION_ID: "555", COMMUNITY_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY, ...extra };
}

async function maintainerOf(toolId: string) {
  const id = ulid();
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, handle, created_at) VALUES (?, ?, ?, 1)`).bind(id, `m${uniq()}`, `m${uniq()}`),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, 1)`).bind(ulid(), id, await sha256Hex(token)),
    DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'added', 1)`).bind(toolId, id),
  ]);
  return { id, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

describe("reading builds", () => {
  it("reads exact pins from requirements.txt", () => {
    expect(parseRequirements(REQS)).toEqual([{ package: "dnspython", pinned: "2.8.0" }, { package: "requests", pinned: "2.32.0" }]);
    expect(parseRequirements("-r base.txt\n-e .\nPillow==13.0.0  # images\n")).toEqual([{ package: "Pillow", pinned: "13.0.0" }]);
  });

  it("finds the final stage's base image and its Docker Hub name", () => {
    expect(baseImage("FROM golang:1.26-alpine AS build\nRUN go build\nFROM alpine:3.22\nCOPY --from=build /x /x\n")).toBe("alpine:3.22");
    expect(baseImage("FROM --platform=$BUILDPLATFORM python:3.12-slim\n")).toBe("python:3.12-slim");
    expect(baseImage("FROM alpine:3.22 AS base\nFROM base\n")).toBeNull();
    expect(baseImage("FROM golang:1.26 AS b\nFROM scratch\n")).toBeNull();
    expect(dockerHubRef("python:3.12-slim")).toEqual({ repo: "library/python", tag: "3.12-slim" });
    expect(dockerHubRef("docker.io/owner/img")).toEqual({ repo: "owner/img", tag: "latest" });
    expect(dockerHubRef("ghcr.io/owner/img:1")).toMatchObject({ error: expect.stringContaining("only Docker Hub") });
    expect(dockerHubRef("alpine@sha256:abc")).toMatchObject({ error: expect.stringContaining("digest") });
    expect(dockerHubRef("${BASE}")).toMatchObject({ error: expect.stringContaining("build argument") });
  });

  it("knows a requirements.txt pin change when it sees one", () => {
    const f = (patch: string) => [{ filename: "requirements.txt", patch }];
    expect(pinOnly(f("@@\n-dnspython==2.8.0\n+dnspython==2.9.0"))).toBe(true);
    expect(pinOnly(f("@@\n-dnspython==2.8.0\n+evil==1.0.0"))).toBe(false);
    expect(pinOnly(f("@@\n+evil==1.0.0"))).toBe(false);
    expect(pinOnly(f("@@\n-dnspython==2.8.0\n+dnspython @ https://example.com/x.whl"))).toBe(false);
    expect(pinOnly(f("@@\n-requests[socks]==2.32.0 ; python_version >= '3.9'\n+requests[socks]==2.33.0 ; python_version >= '3.9'"))).toBe(true);
    // The marker changes too: not just the pin.
    expect(pinOnly(f("@@\n-requests==2.32.0 ; python_version >= '3.9'\n+requests==2.33.0"))).toBe(false);
  });
});

describe("first-party dependencies", () => {
  it("records each pin against PyPI, reading requirements.txt only when the version changes", async () => {
    const t = await tool();
    const h = hosts(t);
    const e = await testEnv();
    const out = await checkBuild(e, t.toolId);
    expect(out!.dependencies.map((d) => [d.package, d.pinned, d.latest, d.state])).toEqual([["dnspython", "2.8.0", "2.9.0", "behind"], ["requests", "2.32.0", "2.32.0", "current"]]);
    expect(h.calls.filter((c) => c.url.includes("/contents/requirements.txt"))).toHaveLength(1);
    // Report mode: no issue.
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ?`).bind(t.toolId).first()).toEqual({ n: 0 });
    const again = hosts(t);
    await checkBuild(e, t.toolId);
    expect(again.calls.some((c) => c.url.includes("/contents/requirements.txt"))).toBe(false);
    const page = (await (await call(`/tools/${t.ref}`, {}, e)).json()) as any;
    expect(page.dependencies).toEqual([
      { package: "dnspython", pinned: "2.8.0", latest: "2.9.0", latest_at: expect.any(Number), state: "behind" },
      { package: "requests", pinned: "2.32.0", latest: "2.32.0", latest_at: expect.any(Number), state: "current" },
    ]);
    expect(page.base_image).toMatchObject({ image: "python:3.12-slim", state: "current" });
  });

  it("leaves community wrappers' dependencies to the upstream watcher", async () => {
    const t = await tool({ firstParty: false });
    hosts(t);
    expect((await checkBuild(await testEnv(), t.toolId))!.dependencies).toEqual([]);
  });

  it("opens an issue in issues mode, and closes it when PyPI moves on", async () => {
    const t = await tool();
    hosts(t);
    const e = await botEnv("issues");
    await checkBuild(e, t.toolId);
    const issue = await DB().prepare(`SELECT title, status, author_kind FROM issues WHERE tool_id = ? AND dedupe_key = 'dependency:dnspython==2.9.0'`).bind(t.toolId).first();
    expect(issue).toEqual({ title: "dnspython 2.9.0 is out", status: "open", author_kind: "system" });
    // A release from yesterday waits, and the older issue is superseded.
    hosts(t, { pypi: { dnspython: { version: "2.10.0", at: Date.now() - DAY }, requests: { version: "2.32.0", at: 1 } } });
    await checkBuild(e, t.toolId);
    expect(await DB().prepare(`SELECT status FROM issues WHERE tool_id = ? AND dedupe_key = 'dependency:dnspython==2.9.0'`).bind(t.toolId).first()).toEqual({ status: "wont_fix" });
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ? AND dedupe_key = 'dependency:dnspython==2.10.0'`).bind(t.toolId).first()).toEqual({ n: 0 });
  });

  it("has the bot open one pull request updating requirements.txt, which a maintainer releases as a patch", async () => {
    const t = await tool();
    const h = hosts(t);
    const e = await botEnv("prs");
    await checkBuild(e, t.toolId);
    expect(h.commits).toEqual([{ path: "requirements.txt", branch: expect.stringMatching(/^otinstaller\/deps-[0-9a-f]{10}$/), content: REQS.replace("dnspython==2.8.0", "dnspython==2.9.0") }]);
    expect(h.did.pulls[0].title).toBe(`Update ${t.name}'s dependencies: dnspython 2.9.0`);
    const row = () => DB().prepare(`SELECT kind, version, pr_number, status, released_version FROM bump_prs WHERE tool_id = ?`).bind(t.toolId).first<any>();
    expect(await row()).toEqual({ kind: "dependency", version: "dnspython==2.9.0", pr_number: 21, status: "open", released_version: null });
    const issue = await DB().prepare(`SELECT body_md FROM issues WHERE tool_id = ? AND dedupe_key = 'dependency:dnspython==2.9.0'`).bind(t.toolId).first<{ body_md: string }>();
    expect(issue!.body_md).toContain(`https://github.com/${t.repo}/pull/21`);
    await checkBuild(e, t.toolId);
    expect(h.did.pulls).toHaveLength(1);
    expect(((await (await call(`/tools/${t.ref}`, {}, e)).json()) as any).bump).toMatchObject({ kind: "dependency", version: "dnspython==2.9.0", number: 21, status: "open" });

    const m = await maintainerOf(t.toolId);
    expect(((await (await call(`/packages/${t.ref}/bump`, { headers: m.headers }, e)).json()) as any)).toMatchObject({ can_release: true, bump: { kind: "dependency", number: 21 } });
    const res = await call(`/packages/${t.ref}/pulls/21/release`, { method: "POST", headers: m.headers, body: "{}" }, e);
    expect(await res.json()).toEqual({ merged: true, upstream_version: "dnspython==2.9.0", version: "1.2.1", attempt: 1 });
    expect(h.did.merged).toEqual([expect.objectContaining({ commit_title: `Update ${t.name}'s dependencies` })]);
    expect(h.did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.2.1" } }]);

    // Published: released, and the dependency's issue closes.
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.2.1', 1, 2, 1, '{}', 'published', 1, 1)`)
      .bind(ulid(), t.toolId).run();
    await sweepBumps(e);
    expect(await row()).toMatchObject({ status: "released", released_version: "1.2.1" });
    expect(await DB().prepare(`SELECT status FROM issues WHERE tool_id = ? AND dedupe_key = 'dependency:dnspython==2.9.0'`).bind(t.toolId).first()).toEqual({ status: "fixed" });
  });

  it("supersedes an open update when PyPI releases again, and in auto mode releases one on its own", async () => {
    const t = await tool();
    const h = hosts(t);
    const e = await botEnv("auto");
    await checkBuild(e, t.toolId, Date.now(), { nightly: true });
    expect(h.did.pulls).toHaveLength(1);
    expect(h.did.merged).toHaveLength(0);
    const newer: Pypi = { dnspython: { version: "2.9.1", at: Date.now() - 9 * DAY }, requests: { version: "2.33.0", at: Date.now() - 8 * DAY } };
    const h2 = hosts(t, { pypi: newer, firstPr: 30 });
    await checkBuild(e, t.toolId, Date.now(), { nightly: true });
    expect(h2.did.closed).toEqual([21]);
    const rows = (await DB().prepare(`SELECT version, status FROM bump_prs WHERE tool_id = ? ORDER BY created_at, version`).bind(t.toolId).all()).results;
    expect(rows).toEqual([{ version: "dnspython==2.9.0", status: "closed" }, { version: "dnspython==2.9.1,requests==2.33.0", status: "open" }]);
    // Four days after the pull request opened, it goes out on its own.
    await checkBuild(e, t.toolId, Date.now() + 5 * DAY, { nightly: true });
    expect(h2.did.merged).toHaveLength(1);
    expect(await DB().prepare(`SELECT status, auto, released_version FROM bump_prs WHERE tool_id = ? AND status != 'closed'`).bind(t.toolId).first())
      .toEqual({ status: "merged", auto: 1, released_version: "1.2.1" });
  });
});

describe("base image rebuilds", () => {
  const OLD = `sha256:${"1".repeat(64)}`;
  const NEW = `sha256:${"2".repeat(64)}`;
  // A day on, so the shared lookup is stale.
  const later = () => Date.now() + 21 * 3_600_000;

  it("records when the base image changed, sharing one Docker Hub lookup a night", async () => {
    const a = await tool();
    const b = await tool();
    hosts(a, { digest: OLD });
    const e = await testEnv();
    // Another test's digest may be cached for this tag; start this one from a known lookup.
    await DB().prepare(`DELETE FROM base_images`).run();
    expect((await checkBuild(e, a.toolId))!.base).toMatchObject({ image: "python:3.12-slim", built_digest: OLD, latest_digest: OLD, state: "current" });
    const at = later();
    const h = hosts(b, { digest: NEW });
    // b is first seen now, on the new digest; a's base has changed since.
    expect((await checkBuild(e, b.toolId, at))!.base).toMatchObject({ built_digest: NEW, state: "current" });
    expect((await checkBuild(e, a.toolId, at))!.base).toMatchObject({ built_digest: OLD, latest_digest: NEW, state: "updated" });
    expect(h.calls.filter((c) => c.method === "HEAD")).toHaveLength(1);
  });

  it("rebuilds in rebuild mode only when the scan found fixable vulnerabilities, and once per base", async () => {
    const e = await botEnv("report", { REBUILD_WATCH: "rebuild" });
    await DB().prepare(`DELETE FROM base_images`).run();
    const clean = await tool({ vuln: "pass" });
    const t = await tool({ vuln: "warn" });
    hosts(clean, { digest: OLD });
    await checkBuild(e, clean.toolId);
    hosts(t, { digest: OLD });
    await checkBuild(e, t.toolId);
    const at = later();
    // A clean scan: the newer base isn't worth a rebuild.
    const hc = hosts(clean, { digest: NEW });
    expect((await checkBuild(e, clean.toolId, at, { nightly: true }))!.base.state).toBe("updated");
    expect(hc.did.dispatched).toEqual([]);
    // Something merged since the release: no rebuild.
    const moved = hosts(t, { digest: NEW, head: "other" });
    expect((await checkBuild(e, t.toolId, at, { nightly: true }))!.base.state).toBe("updated");
    expect(moved.did.dispatched).toEqual([]);
    const h = hosts(t, { digest: NEW });
    await checkBuild(e, t.toolId, at, { nightly: true });
    expect(h.did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.2.1" } }]);
    const row = () => DB().prepare(`SELECT kind, version, pr_number, status, released_version, auto FROM bump_prs WHERE tool_id = ?`).bind(t.toolId).first<any>();
    expect(await row()).toEqual({ kind: "rebuild", version: `rebuild:${"2".repeat(12)}`, pr_number: 0, status: "merged", released_version: "1.2.1", auto: 1 });
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM bump_prs WHERE tool_id = ?`).bind(clean.toolId).first()).toEqual({ n: 0 });
    // Not again the next night.
    await checkBuild(e, t.toolId, at + DAY, { nightly: true });
    expect(h.did.dispatched).toHaveLength(1);
    expect(((await (await call(`/tools/${t.ref}`, {}, e)).json()) as any).bump).toMatchObject({ kind: "rebuild", number: 0, status: "merged" });

    // Nothing arrives; a maintainer releases it again as #0, without any merge.
    await sweepBumps(e, at + 13 * 3_600_000);
    expect((await row()).status).toBe("failed");
    const m = await maintainerOf(t.toolId);
    const res = await call(`/packages/${t.ref}/pulls/0/release`, { method: "POST", headers: m.headers, body: "{}" }, e);
    expect(await res.json()).toMatchObject({ merged: true, version: "1.2.2", attempt: 2 });
    expect(h.did.merged).toEqual([]);
  });

  it("leaves packages whose maintainers turned off releases on their own", async () => {
    const e = await botEnv("report", { REBUILD_WATCH: "rebuild" });
    await DB().prepare(`DELETE FROM base_images`).run();
    const t = await tool({ vuln: "warn" });
    await DB().prepare(`UPDATE tools SET auto_release = 0 WHERE id = ?`).bind(t.toolId).run();
    hosts(t, { digest: OLD });
    await checkBuild(e, t.toolId);
    const h = hosts(t, { digest: NEW });
    await checkBuild(e, t.toolId, later(), { nightly: true });
    expect(h.did.dispatched).toEqual([]);
  });

  it("queues every Docker package with a repository in the community namespace", async () => {
    const t = await tool();
    const sent: any[] = [];
    const e = { ...(await testEnv()), PUBLISH_QUEUE: { sendBatch: async (b: any[]) => void sent.push(...b) } as any };
    expect(await queueBuildChecks(e)).toBeGreaterThan(0);
    expect(sent).toContainEqual({ body: { buildCheckToolId: t.toolId } });
  });
});
