import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { processJob } from "../src/publish";
import { applyScanResults, loadVersion, publishVersion } from "../src/scans";
import { dockerfileChecks } from "../src/submissions";
import { findPin } from "../src/upstream-pin";
import { RELEASE_TEMPLATES } from "../src/release-templates";
import {
  buildDraft, categoriesFrom, detectKind, detectQueued, latestReleaseTag, licenseFromText, missingFields, parseRepoRef, pyprojectInfo, setupCfgInfo, summaryFrom,
  type Facts,
} from "../src/imports";
import { encrypt, sha256Hex, ulid } from "../src/lib/crypto";
import { parseManifest } from "../src/lib/manifest";
import { call, fakeHosts, sent, testEnv, webhook } from "./helpers";
import { installation, tagEvent } from "./fixtures";

const DB = () => env.DB;
const GH = "https://api.github.com";
const GL = "https://gitlab.com/api/v4/projects/";
const DIGEST = `sha256:${"a".repeat(64)}`;
let n = 0;
// A fixed-width counter keeps IDs from colliding ("12" + "34" vs "123" + "4").
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;

beforeEach(() => void (sent.length = 0));

// ---------- detection rules ----------

describe("detection", () => {
  const files = (...names: string[]) => names.map((name) => ({ name, type: name.endsWith("/") ? ("dir" as const) : ("file" as const) })).map((e) => ({ ...e, name: e.name.replace(/\/$/, "") }));

  it.each([
    [["Dockerfile", "README.md", "pyproject.toml"], { scripts: ["tool"] }, "docker"],
    [["pyproject.toml", "README.md"], { scripts: ["tool"] }, "pipx"],
    [["pyproject.toml", "README.md"], { scripts: [] }, null],
    [["README.md", "docs/"], null, "guide"],
    [["mkdocs.yml", "README.md"], null, "guide"],
    [["README.md", "02-passive.md", "LICENSE", ".gitignore"], null, "guide"],
    [["main.go", "README.md"], null, null],
  ] as const)("%j is %s", (names, py, kind) => {
    expect(detectKind(files(...names), py ? { scripts: [...py.scripts] } : null).kind).toBe(kind);
  });

  it("reads names and console scripts from pyproject.toml without a TOML parser", () => {
    expect(pyprojectInfo(`[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "holehe-lite"  # pypi name\nversion = "1.0"\n\n[project.scripts]\nholehe = "holehe.cli:main"\n`))
      .toEqual({ name: "holehe-lite", scripts: ["holehe"] });
    expect(pyprojectInfo(`[tool.poetry]\nname = 'sherlock'\n[tool.poetry.scripts]\nsherlock = 'sherlock:main'\n`)).toEqual({ name: "sherlock", scripts: ["sherlock"] });
    // setuptools projects that keep their console scripts in setup.cfg.
    expect(setupCfgInfo(`[metadata]\nname = email_validator\nversion = attr: email_validator.__version__\n\n[options.entry_points]\nconsole_scripts =\n    email_validator=email_validator.__main__:main\n    other = pkg.cli:run  # second\n\n[flake8]\nmax-line-length = 120\n`))
      .toEqual({ name: "email_validator", scripts: ["email_validator", "other"] });
    expect(setupCfgInfo(`[options.entry_points]\nconsole_scripts = tool = tool.cli:main\ngui_scripts =\n    toolw = tool.gui:main\n`)).toEqual({ name: null, scripts: ["tool"] });
    expect(detectKind(files("setup.cfg", "README.md"), { scripts: ["email_validator"], from: "setup.cfg" })).toEqual({ kind: "pipx", signals: ['setup.cfg console script "email_validator"'] });
  });

  it("maps topics to categories, shortens long descriptions, and picks the newest release", () => {
    expect(categoriesFrom(["osint", "dns", "email", "socmint", "python"])).toEqual(["domain-dns", "email", "social-media"]);
    expect(summaryFrom("short")).toEqual({ summary: null, cut: false });
    const long = summaryFrom("Finds accounts by username across hundreds of social networks, forums and other websites, with JSON output, proxies, timeouts and retries built in");
    expect(long.cut).toBe(true);
    expect(long.summary!.length).toBeLessThanOrEqual(140);
    expect(latestReleaseTag(["v1.2.0", "v1.10.0", "v2.0.0-rc.1", "latest", "1.9.9"])).toBe("v1.10.0");
    expect(latestReleaseTag(["v2.0.0-rc.1"])).toBe("v2.0.0-rc.1");
    expect(latestReleaseTag(["nightly"])).toBeNull();
  });

  it("recognises common license texts", () => {
    expect(licenseFromText("MIT License\n\nCopyright (c) 2026")).toBe("MIT");
    expect(licenseFromText("                                 Apache License\n                           Version 2.0, January 2004")).toBe("Apache-2.0");
    expect(licenseFromText("GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007")).toBe("GPL-3.0-only");
    expect(licenseFromText("All rights reserved")).toBeNull();
  });

  it.each([
    ["https://github.com/Alice/tool", undefined, { provider: "github", path: "Alice/tool" }],
    ["git@github.com:alice/tool.git", undefined, { provider: "github", path: "alice/tool" }],
    ["https://gitlab.com/group/sub/project/-/tree/main", undefined, { provider: "gitlab", path: "group/sub/project" }],
    ["alice/tool", "gitlab", { provider: "gitlab", path: "alice/tool" }],
    ["alice/tool", undefined, null],
    ["https://github.com/alice", undefined, null],
    ["https://example.com/alice/tool", undefined, null],
  ] as const)("parses %s", (input, fallback, want) => {
    expect(parseRepoRef(input, fallback)).toEqual(want);
  });

  it("drafts a Docker tool whose manifest validates once the author fills in the rest", () => {
    const facts: Facts = {
      provider: "github", path: "alice/whois-plus", url: "https://github.com/alice/whois-plus", defaultBranch: "main", namespace: "alice", repoName: "whois-plus",
      description: "WHOIS lookups with registrar and creation dates", topics: ["whois", "osint"], license: "MIT", readme: "README.md", signals: ["Dockerfile"],
      kind: "docker", existingManifest: false, latestTag: null, image: null, pypi: null, docs: null, hasGitlabCi: false, canHoldManifest: true, appInstalled: true,
    };
    const { manifest, assumed } = buildDraft(facts, "docker");
    expect(manifest).toMatchObject({ name: "whois-plus", namespace: "alice", version: "0.1.0", categories: ["domain-dns"], tags: ["whois", "osint"] });
    expect((manifest.runtime as any).image).toBe(`ghcr.io/alice/whois-plus@sha256:${"0".repeat(64)}`);
    expect(assumed.join("\n")).toContain("placeholder");
    expect(missingFields(manifest)).toEqual(["inputs", "outputs", "command", "ethics"]);
    Object.assign(manifest, completion);
    (manifest.runtime as any).command = ["whois-plus", "{domain}"];
    expect(parseManifest(JSON.stringify(manifest)).problems).toEqual([]);
  });

  it("generates the API's release templates from spec/templates", () => {
    expect(RELEASE_TEMPLATES).toEqual(env.TEST_TEMPLATES);
  });
});

// What the author fills in for a tool (the CLI's prompts send the same shape).
const completion = {
  inputs: [{ name: "domain", type: "domain", required: true }],
  outputs: [{ type: "organization" }],
  ethics: { touches_target: false, auth_required: false, collects_personal_data: true },
  test: { input: { domain: "example.com" } },
};

// ---------- fakes ----------

/** A user with linked GitHub and GitLab accounts and an API token. */
async function user(opts: { githubId?: number; gitlabLogin?: string } = {}) {
  const id = ulid();
  const login = `imp${uniq()}`;
  const token = `ot_imp_${id}`;
  const key = env.TOKEN_ENC_KEY;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, created_at) VALUES (?, ?, ?, ?)`).bind(id, login, `${login}@example.com`, Date.now()),
    DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?)`)
      .bind(ulid(), id, String(opts.githubId ?? Number(uniq())), login, await encrypt(key, `gho_${login}`), Date.now()),
    DB().prepare(
      `INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, refresh_token_enc, expires_at, created_at) VALUES (?, ?, 'gitlab', ?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(), id, uniq(), opts.gitlabLogin ?? login, await encrypt(key, "glpat"), await encrypt(key, "glrt"), Date.now() + 3600_000, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

type GhRepo = {
  id: number;
  path: string;
  files: Record<string, string>;
  tags?: string[];
  images?: Record<string, string>;
  owner?: { id: number; type: string };
  admin?: boolean;
  private?: boolean;
  description?: string;
  topics?: string[];
  license?: string | null;
};

const ghRepoJson = (r: GhRepo) => ({
  id: r.id, full_name: r.path, html_url: `https://github.com/${r.path}`, default_branch: "main", description: r.description ?? "WHOIS lookups with registrar and creation dates",
  topics: r.topics ?? ["whois", "osint"], license: r.license === null ? null : { spdx_id: r.license ?? "MIT" }, private: !!r.private, archived: false,
  owner: { login: r.path.split("/")[0], id: r.owner?.id ?? 1, type: r.owner?.type ?? "User" }, permissions: { admin: r.admin ?? true, push: true },
});

/** Lists a directory of the fake repository's files ("" is the root). */
function listing(files: Record<string, string>, dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const entries = new Map<string, string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    entries.set(rest.split("/")[0]!, rest.includes("/") ? "dir" : "file");
  }
  return entries.size ? [...entries].map(([name, type]) => ({ name, type })) : null;
}

/** An OCI registry with the given tag -> digest map; any digest resolves. */
const registry = (images: Record<string, string>) => (req: Request) => {
  const ref = decodeURIComponent(new URL(req.url).pathname.split("/manifests/")[1]!);
  const index = { schemaVersion: 2, manifests: [{ platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "linux", architecture: "arm64" } }] };
  if (ref.startsWith("sha256:")) return index;
  const digest = images[ref];
  return digest ? new Response(JSON.stringify(index), { headers: { "docker-content-digest": digest, "content-type": "application/json" } }) : null;
};

type Commit = { path: string; content: string; branch: string };

/** GitHub routes for one repository, recording what is committed to it. */
function githubRoutes(r: GhRepo, commits: Commit[]): Record<string, any> {
  const base = `${GH}/repos/${r.path}`;
  return {
    [`GET ${GH}/repos/${r.path}`]: ghRepoJson(r),
    [`GET ${GH}/repositories/${r.id}`]: ghRepoJson(r),
    [`GET ${base}/contents`]: (req: Request) => {
      const path = decodeURIComponent(new URL(req.url).pathname.split("/contents")[1] ?? "").replace(/^\//, "");
      if ((req.headers.get("accept") ?? "").includes("raw")) return r.files[path] ?? null;
      if (r.files[path] !== undefined) return { sha: "old", type: "file" };
      return listing(r.files, path);
    },
    [`GET ${base}/tags`]: (r.tags ?? []).map((name) => ({ name })),
    [`GET ${base}/commits/`]: { sha: "abc123" },
    [`POST ${base}/statuses/`]: { ok: true },
    [`GET ${base}/git/ref/heads/main`]: { object: { sha: "base123" } },
    [`POST ${base}/git/refs`]: new Response("{}", { status: 201 }),
    [`PUT ${base}/contents/`]: async (req: Request) => {
      const body = (await req.json()) as { content: string; branch: string };
      const path = decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!);
      commits.push({ path, branch: body.branch, content: new TextDecoder().decode(Uint8Array.from(atob(body.content), (ch) => ch.charCodeAt(0))) });
      return new Response("{}", { status: 201 });
    },
    [`POST ${base}/pulls`]: { html_url: `https://github.com/${r.path}/pull/7`, number: 7 },
  };
}

/** GitHub (user and App tokens), ghcr.io and email for one repository; records commits and pull requests. */
function fakeGithub(r: GhRepo, extra: Record<string, any> = {}) {
  const commits: Commit[] = [];
  const calls = fakeHosts({
    ...githubRoutes(r, commits),
    [`POST ${GH}/app/installations/`]: { token: "ghs_install" },
    [`GET ${GH}/user/memberships/orgs/`]: null,
    "GET https://ghcr.io/v2/": registry(r.images ?? {}),
    "POST https://api.github.com/repos/osintverse/registry-ops/dispatches": new Response(null, { status: 204 }),
    "POST https://api.resend.com/emails": { id: "e" },
    ...extra,
  });
  return { calls, commits };
}

/** Installs the App on the repository; the namespace is the owner's login. */
async function installApp(login: string, ownerId: number, repoId: number, sender = 1) {
  const instId = Number(uniq());
  await webhook("installation", installation(instId, { id: ownerId, login }, [repoId], sender));
  return instId;
}

const post = (path: string, auth: Record<string, string>, body: unknown) => call(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
const patch = (path: string, auth: Record<string, string>, body: unknown) => call(path, { method: "PATCH", headers: auth, body: JSON.stringify(body) });

// ---------- GitHub ----------

describe("importing a GitHub repository", () => {
  async function dockerRepo(over: Partial<GhRepo> = {}) {
    const ownerId = Number(uniq());
    const u = await user({ githubId: ownerId });
    const r: GhRepo = {
      id: Number(uniq()), path: `${u.login}/whois-plus`, owner: { id: ownerId, type: "User" },
      files: { Dockerfile: "FROM alpine", "README.md": "# whois-plus\n", LICENSE: "MIT License" },
      tags: ["v1.2.0", "v1.10.0", "latest"], images: { "1.10.0": DIGEST }, ...over,
    };
    return { u, r, ownerId };
  }

  it("lists the repositories the user administers, with whether the App is installed", async () => {
    const u = await user();
    const ids = [Number(uniq()), Number(uniq()), Number(uniq())];
    const repo = (id: number, name: string, over: Record<string, unknown> = {}) => ({ ...ghRepoJson({ id, path: `${u.login}/${name}`, files: {} }), ...over });
    await installApp(u.login, Number(uniq()), ids[0]!);
    fakeHosts({
      [`GET ${GH}/user/repos`]: [repo(ids[0]!, "tool-a"), repo(ids[1]!, "tool-b"), repo(ids[2]!, "fork", { permissions: { admin: false } }), repo(9, "secret", { private: true })],
    });
    const res = await call("/me/repos?provider=github", { headers: u.auth });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.repos.map((x: any) => [x.path.split("/")[1], x.app_installed])).toEqual([["tool-a", true], ["tool-b", false]]);
    expect(body.install_url).toBe("https://github.com/apps/otinstaller/installations/new");
    const filtered = (await (await call("/me/repos?provider=github&q=TOOL-B", { headers: u.auth })).json()) as any;
    expect(filtered.repos).toHaveLength(1);
  });

  it("detects a Docker tool and drafts its manifest from the repository", async () => {
    const { u, r, ownerId } = await dockerRepo();
    await installApp(u.login, ownerId, r.id);
    fakeGithub(r);
    const res = await post("/imports", u.auth, { repo: `https://github.com/${r.path}` });
    const imp = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(imp).toMatchObject({ status: "draft", detected_kind: "docker", namespace: u.login, signals: ["Dockerfile"], app_installed: true, finish_modes: ["pr", "registry"] });
    expect(imp.draft).toMatchObject({
      name: "whois-plus", namespace: u.login, version: "1.10.0", summary: "WHOIS lookups with registrar and creation dates", license: "MIT", readme: "README.md",
      categories: ["domain-dns"], runtime: { kind: "docker", image: `ghcr.io/${r.path}@${DIGEST}`, platforms: ["linux/amd64", "linux/arm64"] },
    });
    expect(imp.missing).toEqual(["inputs", "outputs", "command", "ethics"]);
    expect(imp.suggested).toEqual(["test"]);
    expect(imp.draft_yaml).toContain("name: whois-plus");
  });

  it("completes the draft, opens a pull request, and the merged manifest publishes on the next tag", async () => {
    const { u, r, ownerId } = await dockerRepo();
    const instId = await installApp(u.login, ownerId, r.id);
    const { commits, calls } = fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: r.path, provider: "github" })).json()) as any;
    const edited = (await (await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { ...completion, runtime: { ...imp.draft.runtime, command: ["whois-plus", "--json", "{domain}"] } },
    })).json()) as any;
    expect(edited).toMatchObject({ status: "ready", problems: [], missing: [] });

    const res = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    const done = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(done).toMatchObject({ status: "finished", finish_mode: "pr", pr_url: `https://github.com/${r.path}/pull/7` });
    expect(commits.map((c) => [c.path, c.branch])).toEqual([["otinstaller.yaml", "otinstaller/import"], [".github/workflows/otinstaller-release.yml", "otinstaller/import"]]);
    expect(commits[1]!.content).toBe(RELEASE_TEMPLATES["github-docker"]);
    const pr = JSON.parse(calls.find((c) => c.url.endsWith("/pulls"))!.body);
    expect(pr).toMatchObject({ head: "otinstaller/import", base: "main", title: "Publish on the OTInstaller Registry" });
    expect(pr.body).toContain("otinstaller release");
    expect((await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" })).status).toBe(409);

    // The author merges, runs the release workflow (which bumps the version and pins the digest) and it tags v1.11.0.
    const merged = YAML.parse(commits[0]!.content);
    merged.version = "1.11.0";
    r.files["otinstaller.yaml"] = YAML.stringify(merged);
    fakeGithub(r);
    const jobId = ((await (await webhook("create", tagEvent(instId, r.path, r.id, "v1.11.0"))).json()) as any).jobId;
    expect(await processJob(await testEnv(), jobId)).toMatchObject({ status: "scanning", problems: [] });
    const view = (await (await call(`/imports/${imp.id}`, { headers: u.auth })).json()) as any;
    expect(view.package).toEqual({ ref: `${u.login}/whois-plus`, published: false });
  });

  it.each([
    ["a repository the user does not administer", { admin: false }, 403, "not_admin"],
    ["a private repository", { private: true }, 400, "repo_not_public"],
  ])("refuses %s", async (_label, over, status, code) => {
    const { u, r } = await dockerRepo(over);
    fakeGithub(r);
    const res = await post("/imports", u.auth, { repo: `https://github.com/${r.path}` });
    expect(res.status).toBe(status);
    expect(((await res.json()) as any).error.code).toBe(code);
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM imports WHERE user_id = ?`).bind(u.id).first()).toEqual({ n: 0 });
  });

  it("drafts without the App, but asks for it before finishing", async () => {
    const { u, r } = await dockerRepo();
    fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    expect(imp.app_installed).toBe(false);
    expect(imp.warnings.join(" ")).toContain("installations/new");
    await patch(`/imports/${imp.id}`, u.auth, { manifest: { ...completion, runtime: { ...imp.draft.runtime, command: ["whois-plus", "{domain}"] } } });
    const res = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatchObject({ code: "app_not_installed", hint: expect.stringContaining("installations/new") });
  });

  it("explains which App permissions are missing when GitHub refuses the branch", async () => {
    const { u, r, ownerId } = await dockerRepo();
    await installApp(u.login, ownerId, r.id);
    fakeGithub(r, { [`POST ${GH}/repos/${r.path}/git/refs`]: new Response('{"message":"Resource not accessible by integration"}', { status: 403 }) });
    const imp = (await (await post("/imports", u.auth, { repo: r.path, provider: "github" })).json()) as any;
    await patch(`/imports/${imp.id}`, u.auth, { manifest: { ...completion, runtime: { ...imp.draft.runtime, command: ["whois-plus", "{domain}"] } } });
    const res = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("github_permission_required");
  });

  it("uses an otinstaller.yaml that is already in the repository and only connects it", async () => {
    const { u, r, ownerId } = await dockerRepo();
    r.files["otinstaller.yaml"] = YAML.stringify({ schema: 1, name: "whois-plus", namespace: u.login, version: "1.0.0", summary: "Existing manifest here", license: "MIT", categories: ["domain-dns"], readme: "README.md", ...completion, runtime: { kind: "docker", image: `ghcr.io/${r.path}@${DIGEST}`, platforms: ["linux/amd64"], command: ["x", "{domain}"], output_format: "json" } });
    await installApp(u.login, ownerId, r.id);
    fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    expect(imp).toMatchObject({ existing_manifest: true, status: "ready", finish_modes: ["connect"], signals: ["otinstaller.yaml"] });
    expect((await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" })).status).toBe(400);
    expect(await (await post(`/imports/${imp.id}/finish`, u.auth, { mode: "connect" })).json()).toMatchObject({ status: "finished", finish_mode: "connect" });
  });

  it("asks for a kind when nothing is recognised, then drafts for the chosen one", async () => {
    const { u, r, ownerId } = await dockerRepo({ files: { "main.go": "package main", "README.md": "# x" }, tags: [] });
    await installApp(u.login, ownerId, r.id);
    fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    expect(imp).toMatchObject({ detected_kind: null, status: "draft", missing: ["kind"] });
    const docker = (await (await patch(`/imports/${imp.id}`, u.auth, { kind: "docker" })).json()) as any;
    expect(docker).toMatchObject({ detected_kind: "docker", missing: ["inputs", "outputs", "command", "ethics"] });
    expect(docker.draft.runtime.image).toContain("sha256:0000");
    expect((await patch(`/imports/${imp.id}`, u.auth, { kind: "rust" })).status).toBe(400);
    expect((await patch(`/imports/${imp.id}`, u.auth, { manifest: { namespace: "someone-else" } })).status).toBe(400);
  });

  it("keeps imports private to the user who started them", async () => {
    const { u, r, ownerId } = await dockerRepo();
    await installApp(u.login, ownerId, r.id);
    fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    const other = await user();
    expect((await call(`/imports/${imp.id}`, { headers: other.auth })).status).toBe(404);
    expect((await call(`/imports/${imp.id}`)).status).toBe(401);
    const mine = (await (await call("/imports", { headers: u.auth })).json()) as any;
    expect(mine.imports.map((i: any) => i.id)).toEqual([imp.id]);
  });
});

// ---------- registry-held manifests ----------

describe("registry-held manifests", () => {
  async function heldPackage() {
    const ghId = Number(uniq());
    const u = await user({ githubId: ghId });
    const r: GhRepo = {
      id: Number(uniq()), path: `${u.login}/whois-plus`, owner: { id: ghId, type: "User" },
      files: { Dockerfile: "FROM alpine", "README.md": "# whois-plus\n" }, tags: ["v1.0.0"], images: { "1.0.0": DIGEST },
    };
    const instId = await installApp(u.login, ghId, r.id, ghId);
    fakeGithub(r);
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    await patch(`/imports/${imp.id}`, u.auth, { manifest: { ...completion, runtime: { ...imp.draft.runtime, command: ["whois-plus", "{domain}"] } } });
    return { u, r, imp, instId };
  }

  it("saves the manifest on the registry, publishes the newest tag from it, and never shows it as signed", async () => {
    const { u, r, imp } = await heldPackage();
    const res = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "registry" });
    const done = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(done).toMatchObject({ status: "finished", finish_mode: "registry", queued_tag: "v1.0.0" });
    const src = await DB().prepare(`SELECT manifest_mode, registry_manifest_json FROM sources WHERE id = ?`).bind(done.source_id ?? (await DB().prepare(`SELECT source_id FROM imports WHERE id = ?`).bind(imp.id).first<any>()).source_id).first<any>();
    expect(src.manifest_mode).toBe("registry");

    const { jobId } = sent[0] as { jobId: string };
    expect(await processJob(await testEnv(), jobId)).toMatchObject({ status: "scanning", problems: [] });
    const v = await DB().prepare(`SELECT v.id, v.manifest_json FROM versions v JOIN publish_jobs j ON j.version_id = v.id WHERE j.id = ?`).bind(jobId).first<any>();
    expect(JSON.parse(v.manifest_json).runtime.image).toBe(`ghcr.io/${r.path}@${DIGEST}`);

    await DB().batch([
      DB().prepare(`UPDATE namespaces SET status = 'active' WHERE name = ?`).bind(u.login),
      DB().prepare(`UPDATE versions SET signer_identity = 'someone', signer_issuer = 'https://token.actions.githubusercontent.com' WHERE id = ?`).bind(v.id),
    ]);
    await publishVersion(await testEnv(), v.id);
    const tool = (await (await call(`/tools/${u.login}/whois-plus`)).json()) as any;
    expect(tool).toMatchObject({ manifest_held_by_registry: true, signed: false });
  });

  it("is only for the repository's owner and only with a published artifact", async () => {
    const owner = await user();
    const orgId = Number(uniq());
    const r: GhRepo = { id: Number(uniq()), path: `org${uniq()}/scanner`, owner: { id: orgId, type: "Organization" }, files: { Dockerfile: "x", "README.md": "# x" }, tags: [] };
    await installApp(r.path.split("/")[0]!, orgId, r.id);
    fakeGithub(r, { [`GET ${GH}/user/memberships/orgs/`]: { state: "active", role: "member" } });
    const imp = (await (await post("/imports", owner.auth, { repo: `https://github.com/${r.path}` })).json()) as any;
    expect(imp.finish_modes).toEqual(["pr"]);
    await patch(`/imports/${imp.id}`, owner.auth, { manifest: { ...completion, runtime: { ...imp.draft.runtime, command: ["s", "{domain}"] } } });
    // No image was found, so the digest is still the placeholder the release workflow would fill in.
    const placeholder = await post(`/imports/${imp.id}/finish`, owner.auth, { mode: "registry" });
    expect(placeholder.status).toBe(409);
    expect(((await placeholder.json()) as any).error.problems[0].code).toBe("artifact_image_not_found");
    await patch(`/imports/${imp.id}`, owner.auth, { manifest: { runtime: { ...imp.draft.runtime, image: `ghcr.io/${r.path}@${DIGEST}`, command: ["s", "{domain}"] } } });
    const res = await post(`/imports/${imp.id}/finish`, owner.auth, { mode: "registry" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("not_repo_owner");
  });

  it("publishes later tags with the image tagged for that version, and refuses when there is none", async () => {
    const { u, r, imp, instId } = await heldPackage();
    await post(`/imports/${imp.id}/finish`, u.auth, { mode: "registry" });
    const newer = `sha256:${"b".repeat(64)}`;
    r.images = { "1.0.0": DIGEST, "v1.1.0": newer };
    fakeGithub(r);
    const ok = ((await (await webhook("create", tagEvent(instId, r.path, r.id, "v1.1.0"))).json()) as any).jobId;
    expect(await processJob(await testEnv(), ok)).toMatchObject({ status: "scanning" });
    const v = await DB().prepare(`SELECT v.manifest_json FROM versions v JOIN publish_jobs j ON j.version_id = v.id WHERE j.id = ?`).bind(ok).first<any>();
    expect(JSON.parse(v.manifest_json)).toMatchObject({ version: "1.1.0", runtime: { image: `ghcr.io/${r.path}@${newer}` } });
    const missing = ((await (await webhook("create", tagEvent(instId, r.path, r.id, "v1.2.0"))).json()) as any).jobId;
    expect(await processJob(await testEnv(), missing)).toMatchObject({ status: "rejected", problems: [{ code: "artifact_image_not_found" }] });
  });

  it("lets owners edit the held manifest, and moves it into the repository with one pull request", async () => {
    const { u, r, imp, instId } = await heldPackage();
    await post(`/imports/${imp.id}/finish`, u.auth, { mode: "registry" });
    await processJob(await testEnv(), (sent[0] as { jobId: string }).jobId);
    const held = JSON.parse((await DB().prepare(`SELECT registry_manifest_json FROM sources WHERE project_id = ?`).bind(String(r.id)).first<any>()).registry_manifest_json);

    const put = (body: unknown, auth = u.auth) => call(`/packages/${u.login}/whois-plus/manifest`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    expect((await put({ manifest: { ...held, summary: "WHOIS lookups, now with RDAP fallback" } })).status).toBe(200);
    const renamed = await put({ manifest: { ...held, name: "other-name" } });
    expect(renamed.status).toBe(400);
    expect(((await renamed.json()) as any).error.problems[0].code).toBe("manifest_name_mismatch");
    expect((await put({ manifest: held }, (await user()).auth)).status).toBe(403);

    const { commits } = fakeGithub(r);
    const pr = await call(`/packages/${u.login}/whois-plus/manifest/pr`, { method: "POST", headers: u.auth });
    expect(pr.status).toBe(201);
    expect(commits[0]!.path).toBe("otinstaller.yaml");
    expect(YAML.parse(commits[0]!.content)).toMatchObject({ version: "1.0.0", summary: "WHOIS lookups, now with RDAP fallback" });

    // After the merge, a tag publishes from the repository's file and the package is no longer registry-held.
    const merged = YAML.parse(commits[0]!.content);
    merged.version = "1.3.0";
    r.files["otinstaller.yaml"] = YAML.stringify(merged);
    fakeGithub(r);
    const jobId = ((await (await webhook("create", tagEvent(instId, r.path, r.id, "v1.3.0"))).json()) as any).jobId;
    expect(await processJob(await testEnv(), jobId)).toMatchObject({ status: "scanning" });
    expect(await DB().prepare(`SELECT manifest_mode, registry_manifest_json FROM sources WHERE project_id = ?`).bind(String(r.id)).first())
      .toEqual({ manifest_mode: "repo", registry_manifest_json: null });
    expect((await put({ manifest: held })).status).toBe(409);
  });
});

// ---------- community wrappers ----------

describe("community wrappers", () => {
  /** A community admin, an upstream repository they don't own, and a wrapper repository in osintverse-community. */
  async function setup(upstreamOver: Partial<GhRepo> = {}) {
    const u = await user();
    await DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES ('ns_community', ?, 'owner')`).bind(u.id).run();
    const name = `sherlock${uniq()}`;
    const upstream: GhRepo = {
      id: Number(uniq()), path: `upstream${uniq()}/${name}`, owner: { id: Number(uniq()), type: "Organization" }, admin: false,
      files: { Dockerfile: "FROM python", "README.md": "# sherlock", LICENSE: "MIT License" }, tags: ["v0.15.0"], images: { "0.15.0": DIGEST },
      description: "Finds accounts by username across social networks", topics: ["username", "osint"], ...upstreamOver,
    };
    const wrapper: GhRepo = { id: Number(uniq()), path: `osintverse-community/${name}`, owner: { id: 4242, type: "Organization" }, files: {} };
    const instId = Number(uniq());
    await DB().prepare(
      `INSERT INTO installations (id, github_installation_id, namespace_id, repo_ids, account_login, account_type, repository_selection) VALUES (?, ?, 'ns_community', ?, 'osintverse-community', 'Organization', 'selected')`,
    ).bind(ulid(), instId, JSON.stringify([String(wrapper.id)])).run();
    return { u, name, upstream, wrapper, instId };
  }

  it("leaves bulk community imports to osintverse-community admins", async () => {
    const u = await user();
    const res = await post("/imports", u.auth, { repos: ["https://github.com/someone/sherlock", "https://github.com/someone/maigret"], community: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("not_community_admin");
    // Without --community, a repository they can't administer points them at the wrapper route.
    const { upstream } = await setup();
    fakeGithub(upstream);
    const plain = await post("/imports", u.auth, { repo: `https://github.com/${upstream.path}` });
    expect(((await plain.json()) as any).error).toMatchObject({ code: "not_admin", hint: expect.stringContaining("community wrapper") });
  });

  it("drafts a labelled wrapper and opens its pull request in the wrapper repository", async () => {
    const { u, name, upstream, wrapper, instId } = await setup();
    const wrapperCommits: Commit[] = [];
    fakeGithub(upstream, githubRoutes(wrapper, wrapperCommits));
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${upstream.path}`, community: true })).json()) as any;
    expect(imp).toMatchObject({ community: true, namespace: "osintverse-community", finish_modes: ["submit", "wrapper"], can_hold_manifest: false });
    // The App isn't installed on the upstream repository, and needn't be: the wizard isn't held up.
    expect(imp.app_installed).toBe(false);
    expect(imp.install_url).toBeUndefined();
    expect(imp.draft).toMatchObject({ name, namespace: "osintverse-community", homepage: `https://github.com/${upstream.path}`, runtime: { image: `ghcr.io/${upstream.path}@${DIGEST}` } });
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "username", type: "username", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics,
        runtime: { ...imp.draft.runtime, command: ["sherlock", "{username}"] } },
    });

    expect(((await (await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" })).json()) as any).error.code).toBe("invalid_mode");
    expect(((await (await post(`/imports/${imp.id}/finish`, u.auth, {})).json()) as any).error.code).toBe("wrapper_required");
    const done = (await (await post(`/imports/${imp.id}/finish`, u.auth, { wrapper_repo: `https://github.com/${wrapper.path}` })).json()) as any;
    expect(done).toMatchObject({ status: "finished", finish_mode: "wrapper", wrapper_repo: `github:${wrapper.path}`, pr_url: `https://github.com/${wrapper.path}/pull/7` });
    // The upstream image is already published, so the wrapper needs only the manifest and a README with credit.
    expect(wrapperCommits.map((c) => c.path)).toEqual(["otinstaller.yaml", "README.md"]);
    expect(wrapperCommits[1]!.content).toContain(`https://github.com/${upstream.path}`);
    expect(YAML.parse(wrapperCommits[0]!.content)).toMatchObject({ readme: "README.md", homepage: `https://github.com/${upstream.path}` });

    // A tag on the wrapper publishes it into osintverse-community, labelled Community-packaged.
    wrapper.files = { "otinstaller.yaml": wrapperCommits[0]!.content, "README.md": wrapperCommits[1]!.content };
    fakeGithub(upstream, githubRoutes(wrapper, []));
    const jobId = ((await (await webhook("create", tagEvent(instId, wrapper.path, wrapper.id, "v0.15.0"))).json()) as any).jobId;
    expect(await processJob(await testEnv(), jobId)).toMatchObject({ status: "scanning", problems: [] });
    expect(await DB().prepare(`SELECT t.community_packaged, t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = 'osintverse-community' AND t.name = ?`).bind(name).first())
      .toEqual({ community_packaged: 1, repo_url: `https://github.com/${wrapper.path}` });
  });

  it("builds the image in the wrapper when upstream publishes none, and refuses a wrapper outside the namespace", async () => {
    const { u, upstream, wrapper } = await setup({ images: {} });
    const wrapperCommits: Commit[] = [];
    const elsewhere: GhRepo = { id: Number(uniq()), path: `${u.login}/sherlock-wrap`, owner: { id: 1, type: "User" }, files: {} };
    fakeGithub(upstream, { ...githubRoutes(wrapper, wrapperCommits), ...githubRoutes(elsewhere, []) });
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${upstream.path}`, community: true })).json()) as any;
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "username", type: "username", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics,
        runtime: { ...imp.draft.runtime, command: ["sherlock", "{username}"] } },
    });
    const outside = await post(`/imports/${imp.id}/finish`, u.auth, { wrapper_repo: `https://github.com/${elsewhere.path}` });
    expect(outside.status).toBe(409);
    expect(((await outside.json()) as any).error.code).toBe("wrapper_not_community");
    await post(`/imports/${imp.id}/finish`, u.auth, { wrapper_repo: wrapper.path });
    expect(wrapperCommits.map((c) => c.path)).toEqual(["otinstaller.yaml", "README.md", ".github/workflows/otinstaller-release.yml"]);
    expect(YAML.parse(wrapperCommits[0]!.content).runtime.image).toBe(`ghcr.io/${wrapper.path}@sha256:${"0".repeat(64)}`);
  });

  it.each([
    ["no license", { license: null, files: { Dockerfile: "x", "README.md": "# x" } }, 400, "license_not_redistributable"],
    ["a proprietary license", { license: "LicenseRef-Proprietary" }, 400, "license_not_redistributable"],
    ["its own otinstaller.yaml", { files: { Dockerfile: "x", "README.md": "# x", "otinstaller.yaml": "schema: 1" } }, 409, "upstream_has_manifest"],
  ])("refuses an upstream with %s", async (_label, over, status, code) => {
    const { u, upstream } = await setup(over as Partial<GhRepo>);
    fakeGithub(upstream);
    const res = await post("/imports", u.auth, { repo: `https://github.com/${upstream.path}`, community: true });
    expect(res.status).toBe(status);
    expect(((await res.json()) as any).error.code).toBe(code);
  });
});

// ---------- GitLab ----------

type GlProject = { id: number; path: string; files: Record<string, string>; tags?: string[]; level?: number; kind?: "user" | "group"; topics?: string[] };

function fakeGitlab(p: GlProject, extra: Record<string, any> = {}) {
  const commits: any[] = [];
  const json = {
    id: p.id, path_with_namespace: p.path, web_url: `https://gitlab.com/${p.path}`, visibility: "public", default_branch: "main", archived: false,
    namespace: { id: p.id + 1000, path: p.path.split("/")[0], kind: p.kind ?? "user", full_path: p.path.split("/").slice(0, -1).join("/") },
    permissions: { project_access: { access_level: p.level ?? 40 }, group_access: null }, description: "Find accounts that use a phone number",
    topics: p.topics ?? ["phone"], license: { key: "apache-2.0" }, star_count: 2,
  };
  const calls = fakeHosts({
    [`GET ${GL}`]: (req) => {
      const id = decodeURIComponent(new URL(req.url).pathname.slice("/api/v4/projects/".length));
      return id === String(p.id) || id === p.path ? json : null;
    },
    [`GET ${GL}${p.id}/repository/tree`]: (req) =>
      listing(p.files, new URL(req.url).searchParams.get("path") ?? "")?.map((e) => ({ name: e.name, type: e.type === "dir" ? "tree" : "blob" })) ?? null,
    [`GET ${GL}${p.id}/repository/files/`]: (req) => p.files[decodeURIComponent(new URL(req.url).pathname.split("/files/")[1]!.replace(/\/raw$/, ""))] ?? null,
    [`GET ${GL}${p.id}/repository/tags`]: (p.tags ?? []).map((name) => ({ name })),
    [`POST ${GL}${p.id}/hooks`]: { id: 77 },
    [`POST ${GL}${p.id}/repository/commits`]: async (req) => {
      commits.push(await req.json());
      return new Response("{}", { status: 201 });
    },
    [`POST ${GL}${p.id}/merge_requests`]: { web_url: `https://gitlab.com/${p.path}/-/merge_requests/3`, iid: 3 },
    "GET https://pypi.org/pypi/": (req) => req.url.includes("phoneinfo")
      ? { info: { version: "2.1.0" }, urls: [{ packagetype: "sdist", filename: "x.tar.gz", digests: { sha256: "1".repeat(64) } }, { packagetype: "bdist_wheel", filename: "phoneinfo-2.1.0-py3-none-any.whl", digests: { sha256: "c".repeat(64) } }] }
      : null,
    ...extra,
  });
  return { calls, commits };
}

const pipxFiles = {
  "pyproject.toml": `[project]\nname = "phoneinfo"\nversion = "2.1.0"\n\n[project.scripts]\nphoneinfo = "phoneinfo.cli:main"\n`,
  "README.md": "# phoneinfo\n",
};

describe("importing a GitLab project", () => {
  it("lists the projects the user maintains", async () => {
    const u = await user();
    const calls = fakeHosts({ "GET https://gitlab.com/api/v4/projects?": [{ id: 5, path_with_namespace: `${u.login}/a`, web_url: "https://gitlab.com/x/a", default_branch: "main", archived: false, description: null }] });
    const body = (await (await call("/me/repos?provider=gitlab&q=a", { headers: u.auth })).json()) as any;
    expect(body.repos).toEqual([expect.objectContaining({ project_id: "5", path: `${u.login}/a`, published_as: null })]);
    expect(calls[0]!.url).toContain("min_access_level=40");
    expect(calls[0]!.url).toContain("search=a");
  });

  it("detects a pipx tool from pyproject.toml and PyPI, and opens a merge request with the CI template", async () => {
    const u = await user();
    const p: GlProject = { id: Number(uniq()), path: `${u.login}/phoneinfo`, files: { ...pipxFiles }, tags: ["v2.1.0"] };
    const { commits, calls } = fakeGitlab(p);
    const imp = (await (await post("/imports", u.auth, { repo: `https://gitlab.com/${p.path}` })).json()) as any;
    expect(imp).toMatchObject({ detected_kind: "pipx", namespace: u.login, finish_modes: ["pr", "registry"] });
    expect(imp.draft).toMatchObject({
      license: "Apache-2.0", categories: ["phone"], version: "2.1.0",
      runtime: { kind: "pipx", package: "phoneinfo", package_version: "2.1.0", entrypoint: "phoneinfo", wheel_sha256: "c".repeat(64) },
    });
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "phone", type: "phone", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics, runtime: { ...imp.draft.runtime, command: ["phoneinfo", "{phone}"] } },
    });
    const done = (await (await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" })).json()) as any;
    expect(done).toMatchObject({ status: "finished", pr_url: `https://gitlab.com/${p.path}/-/merge_requests/3` });
    expect(commits[0]).toMatchObject({ branch: "otinstaller/import", start_branch: "main" });
    expect(commits[0].actions.map((a: any) => [a.action, a.file_path])).toEqual([["create", "otinstaller.yaml"], ["create", ".gitlab-ci.yml"]]);
    expect(commits[0].actions[1].content).toBe(RELEASE_TEMPLATES["gitlab-pipx"]);
    // The project webhook is created too, so the first tag after the merge publishes.
    expect(calls.some((c) => c.url.endsWith(`/projects/${p.id}/hooks`))).toBe(true);
    expect(await DB().prepare(`SELECT manifest_mode FROM sources WHERE provider = 'gitlab' AND project_id = ?`).bind(String(p.id)).first()).toEqual({ manifest_mode: "repo" });
  });

  it("puts the release job in its own file when the project already has a pipeline", async () => {
    const u = await user();
    const p: GlProject = { id: Number(uniq()), path: `${u.login}/phoneinfo`, files: { ...pipxFiles, ".gitlab-ci.yml": "test:\n  script: [pytest]\n" } };
    const { commits, calls } = fakeGitlab(p);
    const imp = (await (await post("/imports", u.auth, { repo: `https://gitlab.com/${p.path}` })).json()) as any;
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "phone", type: "phone", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics, runtime: { ...imp.draft.runtime, command: ["phoneinfo", "{phone}"] } },
    });
    await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(commits[0].actions.map((a: any) => a.file_path)).toEqual(["otinstaller.yaml", ".gitlab/otinstaller-release.yml"]);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/merge_requests"))!.body).description).toContain("local: .gitlab/otinstaller-release.yml");
  });

  it("drafts a guide from docs/ that is ready without further input", async () => {
    const u = await user();
    const p: GlProject = { id: Number(uniq()), path: `${u.login}/phone-osint-guide`, files: { "README.md": "# Guide", "docs/02-carriers.md": "x", "docs/index.md": "x", "docs/01-scope.md": "x" } };
    const { commits } = fakeGitlab(p);
    const imp = (await (await post("/imports", u.auth, { repo: `https://gitlab.com/${p.path}` })).json()) as any;
    expect(imp).toMatchObject({ detected_kind: "guide", status: "ready", missing: [], suggested: ["related_tools"] });
    expect(imp.draft).toMatchObject({ kind: "guide", title: "Phone osint guide", topics: ["phone"], content: { root: "docs/", nav: ["index.md", "01-scope.md", "02-carriers.md"] } });
    await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(commits[0].actions.map((a: any) => a.file_path)).toEqual(["otinstaller.yaml", ".gitlab-ci.yml"]);
    expect(commits[0].actions[1].content).toBe(RELEASE_TEMPLATES["gitlab-guide"]);
  });

  it("won't import a mirror of a package the user already publishes from the other host", async () => {
    const u = await user();
    const nsId = ulid(), toolId = ulid();
    await DB().batch([
      DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, 'github', ?, ?, 'user', 'active', 0)`).bind(nsId, uniq(), `${u.login}-gh`),
      DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(nsId, u.id),
      DB().prepare(`INSERT INTO tools (id, namespace_id, name, summary, categories, created_at, updated_at) VALUES (?, ?, 'phoneinfo', 'Phone lookups', '[]', 0, 0)`).bind(toolId, nsId),
      DB().prepare(`INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url, created_at) VALUES (?, ?, ?, 'github', ?, ?, ?, 0)`)
        .bind(ulid(), toolId, nsId, uniq(), `${u.login}/PhoneInfo`, `https://github.com/${u.login}/PhoneInfo`),
    ]);
    const p: GlProject = { id: Number(uniq()), path: `${u.login}/phoneinfo`, files: { ...pipxFiles } };
    fakeGitlab(p);
    const imp = (await (await post("/imports", u.auth, { repo: `https://gitlab.com/${p.path}` })).json()) as any;
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "phone", type: "phone", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics, runtime: { ...imp.draft.runtime, command: ["phoneinfo", "{phone}"] } },
    });
    const res = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("mirror_already_imported");
  });

  it("refuses Developers, and asks to re-authorize when the merge request needs the api scope", async () => {
    const u = await user();
    const dev: GlProject = { id: Number(uniq()), path: `${u.login}/x`, files: pipxFiles, level: 30 };
    fakeGitlab(dev);
    const res = await post("/imports", u.auth, { repo: `https://gitlab.com/${dev.path}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("not_maintainer");

    const p: GlProject = { id: Number(uniq()), path: `${u.login}/phone-osint-guide`, files: { "README.md": "# g", "docs/index.md": "x" } };
    fakeGitlab(p, { [`POST ${GL}${p.id}/hooks`]: new Response("insufficient_scope", { status: 403 }) });
    const imp = (await (await post("/imports", u.auth, { repo: `https://gitlab.com/${p.path}` })).json()) as any;
    const fin = await post(`/imports/${imp.id}/finish`, u.auth, { mode: "pr" });
    expect(fin.status).toBe(403);
    expect(((await fin.json()) as any).error).toMatchObject({ code: "gitlab_scope_required", hint: expect.stringContaining("scope=api") });
  });
});

// ---------- bulk ----------

describe("bulk import", () => {
  it("queues one detection per repository and records what each found", async () => {
    const u = await user();
    const a: GlProject = { id: Number(uniq()), path: `${u.login}/phoneinfo`, files: { ...pipxFiles } };
    const res = await post("/imports", u.auth, {
      repos: [`https://gitlab.com/${a.path}`, `https://gitlab.com/${u.login}/gone`, `https://gitlab.com/${a.path}`, `https://gitlab.com/${u.login}/empty`],
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(202);
    expect(body.imports.map((i: any) => i.status)).toEqual(["detecting", "detecting", "detecting"]);
    expect(sent).toHaveLength(3);

    const empty: GlProject = { id: a.id + 1, path: `${u.login}/empty`, files: { "main.go": "package main" } };
    for (const m of sent as { importId: string }[]) {
      const row = await DB().prepare(`SELECT path FROM imports WHERE id = ?`).bind(m.importId).first<{ path: string }>();
      if (row!.path === a.path) fakeGitlab(a);
      else if (row!.path === empty.path) fakeGitlab(empty);
      else fakeHosts({ [`GET ${GL}`]: null });
      await detectQueued(await testEnv(), m.importId);
    }
    const list = (await (await call(`/imports?batch=${body.batch_id}`, { headers: u.auth })).json()) as any;
    const byRepo = Object.fromEntries(list.imports.map((i: any) => [i.repo, i]));
    expect(byRepo[a.path]).toMatchObject({ status: "draft", detected_kind: "pipx" });
    expect(byRepo[`${u.login}/gone`]).toMatchObject({ status: "failed", error: { code: "project_not_found" } });
    expect(byRepo[empty.path]).toMatchObject({ status: "draft", detected_kind: null, missing: ["kind"] });
  });

  it("accepts at most 50 repositories and rejects what is not a repository", async () => {
    const u = await user();
    const many = Array.from({ length: 51 }, (_, i) => `https://github.com/${u.login}/r${i}`);
    expect(((await (await post("/imports", u.auth, { repos: many })).json()) as any).error.code).toBe("too_many_repos");
    expect(((await (await post("/imports", u.auth, { repo: "https://example.com/a/b" })).json()) as any).error.code).toBe("invalid_repo");
  });
});

// ---------- community submissions ----------

describe("community submissions", () => {
  const DOCKERFILE = (path: string) => `FROM golang:1.26-alpine AS build\nRUN go install github.com/${path}@v0.15.0\n\nFROM alpine:3.22\nCOPY --from=build /go/bin/tool /usr/local/bin/tool\nUSER 65534\nENTRYPOINT ["tool"]\n`;
  const BOT = { COMMUNITY_APP_ID: "77", COMMUNITY_INSTALLATION_ID: "555" };

  /** Someone who isn't a community admin, an upstream they don't own, the main App on osintverse-community, and fakes. */
  async function setup(upstreamOver: Partial<GhRepo> = {}) {
    const u = await user();
    const name = `tool${uniq()}`;
    const upstream: GhRepo = {
      id: Number(uniq()), path: `upstream${uniq()}/${name}`, owner: { id: Number(uniq()), type: "Organization" }, admin: false,
      files: { Dockerfile: "FROM python", "README.md": `# ${name}`, LICENSE: "MIT License" }, tags: ["v0.15.0"], images: {},
      description: "Finds accounts by username across social networks", topics: ["username", "osint"], ...upstreamOver,
    };
    const wrapper: GhRepo = { id: Number(uniq()), path: `osintverse-community/${name}`, owner: { id: 4242, type: "Organization" }, files: {} };
    const instId = Number(uniq());
    await DB().prepare(
      `INSERT INTO installations (id, github_installation_id, namespace_id, repo_ids, account_login, account_type, repository_selection) VALUES (?, ?, 'ns_community', '[]', 'osintverse-community', 'Organization', 'all')`,
    ).bind(ulid(), instId).run();
    const commits: Commit[] = [];
    const bot: { dispatched: unknown[]; tagged: unknown[]; archived: number } = { dispatched: [], tagged: [], archived: 0 };
    const routes: Record<string, any> = {
      ...githubRoutes(wrapper, commits),
      [`POST ${GH}/orgs/osintverse-community/repos`]: async (req: Request) => {
        const b = (await req.json()) as { name: string };
        if (b.name !== name) return new Response("{}", { status: 422 });
        return new Response(JSON.stringify({ id: wrapper.id, full_name: wrapper.path, html_url: `https://github.com/${wrapper.path}`, default_branch: "main" }), { status: 201 });
      },
      [`POST ${GH}/repos/${wrapper.path}/actions/workflows/`]: async (req: Request) => (bot.dispatched.push(await req.json()), new Response(null, { status: 204 })),
      [`POST ${GH}/repos/${wrapper.path}/git/refs`]: async (req: Request) => (bot.tagged.push(await req.json()), new Response("{}", { status: 201 })),
      [`PATCH ${GH}/repos/${wrapper.path}`]: () => (bot.archived++, { archived: true }),
    };
    const fake = (more: Record<string, any> = {}) => fakeGithub(upstream, { ...routes, ...more });
    fake();
    const base = await testEnv();
    const e = { ...base, ...BOT, COMMUNITY_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY };
    const as = (auth: Record<string, string>) => ({
      post: (path: string, body: unknown) => call(path, { method: "POST", headers: auth, body: JSON.stringify(body) }, e),
      put: (path: string, body: unknown) => call(path, { method: "PUT", headers: auth, body: JSON.stringify(body) }, e),
    });
    return { u, name, upstream, wrapper, instId, commits, bot, fake, e, as };
  }

  /** A community import with the fields the wizard asks for filled in. */
  async function draft(u: { auth: Record<string, string> }, upstream: GhRepo) {
    const imp = (await (await post("/imports", u.auth, { repo: `https://github.com/${upstream.path}`, community: true })).json()) as any;
    expect(imp).toMatchObject({ community: true, namespace: "osintverse-community", finish_modes: ["submit", "wrapper"] });
    await patch(`/imports/${imp.id}`, u.auth, {
      manifest: { inputs: [{ name: "username", type: "username", required: true }], outputs: [{ type: "account" }], ethics: completion.ethics,
        runtime: { ...imp.draft.runtime, command: ["tool", "{username}"] }, test: { input: { username: "example" } } },
    });
    return imp;
  }

  const passing = { signature: { status: "pass" as const, identity: "https://github.com/osintverse-community/x", issuer: "https://token.actions.githubusercontent.com" },
    vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0, fixable_critical: 0, fixable_high: 0 }, secrets: { count: 0 }, malware: { count: 0 }, smoke: { status: "pass" as const } };

  it("lets anyone submit a wrapper: the bot creates the repository and starts the build, and a reviewer approves the first release", async () => {
    const s = await setup();
    const imp = await draft(s.u, s.upstream);
    // Without the community bot set up, nothing is created.
    const off = await post(`/imports/${imp.id}/finish`, s.u.auth, { mode: "submit", dockerfile: DOCKERFILE(s.upstream.path) });
    expect(off.status).toBe(503);
    expect(((await off.json()) as any).error.code).toBe("community_bot_missing");
    const me = s.as(s.u.auth);
    expect(((await (await me.post(`/imports/${imp.id}/finish`, { mode: "submit" })).json()) as any).error.code).toBe("dockerfile_required");

    const res = await me.post(`/imports/${imp.id}/finish`, { mode: "submit", dockerfile: DOCKERFILE(s.upstream.path) });
    const done = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(done).toMatchObject({ status: "finished", submission: { status: "releasing" } });
    const number = done.submission.number;
    expect(s.commits.map((c) => c.path)).toEqual(["otinstaller.yaml", "README.md", "Dockerfile", ".github/workflows/otinstaller-release.yml"]);
    expect(s.commits[1]!.content).toContain(`Packaged by @${s.u.login}`);
    expect(YAML.parse(s.commits[0]!.content)).toMatchObject({ namespace: "osintverse-community", homepage: `https://github.com/${s.upstream.path}`, runtime: { image: `ghcr.io/${s.wrapper.path}@sha256:${"0".repeat(64)}` } });
    expect(s.bot.dispatched).toEqual([{ ref: "main", inputs: { version: "0.15.0" } }]);
    expect(await DB().prepare(`SELECT connected_by, installation_id IS NOT NULL AS covered FROM sources WHERE project_id = ?`).bind(String(s.wrapper.id)).first()).toEqual({ connected_by: s.u.id, covered: 1 });

    const page = (await (await call(`/submissions/${number}`)).json()) as any;
    expect(page.submission).toMatchObject({ number, name: s.name, status: "releasing", builds: true, template_conformant: true, submitted_by: s.u.login.toLowerCase(), dockerfile_checks: [] });
    expect(((await (await call("/submissions")).json()) as any).submissions.some((x: any) => x.number === number)).toBe(true);

    // The release workflow builds, commits the digest and tags; the tag publishes like any wrapper, then waits for review.
    s.wrapper.files = { "otinstaller.yaml": s.commits[0]!.content.replace("0".repeat(64), "a".repeat(64)), "README.md": s.commits[1]!.content };
    s.upstream.images = { "0.15.0": DIGEST };
    const jobId = ((await (await webhook("create", tagEvent(s.instId, s.wrapper.path, s.wrapper.id, "v0.15.0"))).json()) as any).jobId;
    s.fake();
    expect(await processJob(await testEnv(), jobId)).toMatchObject({ status: "scanning", problems: [] });
    const tool = await DB().prepare(`SELECT id, needs_first_review, submitted_by, upstream_url FROM tools WHERE name = ?`).bind(s.name).first<any>();
    expect(tool).toMatchObject({ needs_first_review: 1, submitted_by: s.u.id, upstream_url: `https://github.com/${s.upstream.path}` });
    const v = (await loadVersion(await testEnv(), "v.tool_id = ?", tool.id))!;
    expect(await applyScanResults(await testEnv(), v, passing)).toMatchObject({ status: "awaiting_review" });
    expect(((await (await call(`/submissions/${number}`)).json()) as any).submission).toMatchObject({ status: "in_review", release: { version: "0.15.0", status: "awaiting_review" } });

    // The submitter can't approve their own, nor can someone without the reviewer role; a reviewer can.
    expect(((await (await me.post(`/submissions/${number}/approve`, {})).json()) as any).error.code).toBe("not_reviewer");
    await DB().prepare(`INSERT INTO community_roles (user_id, role, granted_at) VALUES (?, 'reviewer', ?)`).bind(s.u.id, Date.now()).run();
    expect(((await (await me.post(`/submissions/${number}/approve`, {})).json()) as any).error.code).toBe("self_review");
    await DB().prepare(`UPDATE users SET is_reviewer = 1 WHERE id = ?`).bind(s.u.id).run();
    expect(((await (await me.post(`/admin/versions/${v.id}/approve`, {})).json()) as any).error.code).toBe("self_review");
    const reviewer = await user();
    await DB().prepare(`UPDATE users SET is_reviewer = 1 WHERE id = ?`).bind(reviewer.id).run();
    expect((await s.as(reviewer.auth).post(`/submissions/${number}/approve`, { note: "Looks right." })).status).toBe(200);
    expect(await DB().prepare(`SELECT status FROM versions WHERE id = ?`).bind(v.id).first()).toEqual({ status: "published" });
    expect(await DB().prepare(`SELECT needs_first_review FROM tools WHERE id = ?`).bind(tool.id).first()).toEqual({ needs_first_review: 0 });
    expect(await DB().prepare(`SELECT reason FROM tool_maintainers WHERE tool_id = ? AND user_id = ?`).bind(tool.id, s.u.id).first()).toEqual({ reason: "submitter" });
    expect(((await (await call(`/submissions/${number}`)).json()) as any).submission).toMatchObject({ status: "published", tool: `osintverse-community/${s.name}`, reviewer: reviewer.login.toLowerCase() });
  });

  it("tags a release of upstream's own wheel, and refuses a PyPI project that isn't upstream's", async () => {
    const s = await setup({ files: { ...pipxFiles, LICENSE: "MIT License" }, tags: ["v2.1.0"] });
    const pypi = (home: string) => ({
      "GET https://pypi.org/pypi/": (req: Request) => new URL(req.url).pathname.includes("phoneinfo")
        ? { info: { version: "2.1.0", project_urls: { Source: home } }, urls: [{ packagetype: "bdist_wheel", filename: "phoneinfo-2.1.0-py3-none-any.whl", digests: { sha256: "c".repeat(64) } }] }
        : null,
    });
    s.fake(pypi(`https://github.com/${s.upstream.path}`));
    const imp = await draft(s.u, s.upstream);
    expect(imp.draft.runtime).toMatchObject({ kind: "pipx", package: "phoneinfo" });
    s.fake(pypi("https://github.com/someone-else/phoneinfo"));
    expect(((await (await s.as(s.u.auth).post(`/imports/${imp.id}/finish`, { mode: "submit" })).json()) as any).error.code).toBe("pypi_not_upstream");
    s.fake(pypi(`https://github.com/${s.upstream.path}`));
    const done = (await (await s.as(s.u.auth).post(`/imports/${imp.id}/finish`, { mode: "submit" })).json()) as any;
    expect(done.submission).toMatchObject({ status: "releasing" });
    expect(s.commits.map((c) => c.path)).toEqual(["otinstaller.yaml", "README.md"]);
    expect(s.bot.tagged).toEqual([{ ref: "refs/tags/v2.1.0", sha: "base123" }]);
  });

  it("waits for a reviewer before building a Dockerfile off the template, and lets the submitter fix it", async () => {
    const s = await setup();
    const imp = await draft(s.u, s.upstream);
    const loose = `FROM ubuntu:latest\nRUN apt-get update && apt-get install -y curl && curl -fsSL https://example.org/i.sh | sh\n`;
    const done = (await (await s.as(s.u.auth).post(`/imports/${imp.id}/finish`, { mode: "submit", dockerfile: loose })).json()) as any;
    expect(done.submission).toMatchObject({ status: "submitted" });
    expect(s.bot.dispatched).toEqual([]);
    const page = (await (await call(`/submissions/${done.submission.number}`)).json()) as any;
    expect(page.submission.template_conformant).toBe(false);
    expect(page.submission.dockerfile_checks.map((c: any) => c.code)).toEqual(["dockerfile_base", "dockerfile_root", "dockerfile_pipe_shell", "dockerfile_no_pin"]);

    // The submitter fixes it: committed again and released, with no reviewer needed to start it.
    const fixed = (await (await s.as(s.u.auth).put(`/submissions/${done.submission.number}`, { dockerfile: DOCKERFILE(s.upstream.path) })).json()) as any;
    expect(fixed).toMatchObject({ status: "releasing", version: "0.15.0" });
    expect(s.commits.filter((c) => c.path === "Dockerfile").at(-1)!.content).toContain("alpine:3.22");
    expect(s.bot.dispatched).toHaveLength(1);
    expect(((await (await s.as(s.u.auth).put(`/submissions/${done.submission.number}`, { dockerfile: loose })).json()) as any).error.code).toBe("not_pending");
  });

  it("lets a reviewer start a non-conformant build, or turn a submission down and archive its repository", async () => {
    const s = await setup();
    const imp = await draft(s.u, s.upstream);
    const done = (await (await s.as(s.u.auth).post(`/imports/${imp.id}/finish`, { mode: "submit", dockerfile: "FROM debian:bookworm-slim\nRUN echo hi\n" })).json()) as any;
    const n = done.submission.number;
    const reviewer = await user();
    await DB().prepare(`INSERT INTO community_roles (user_id, role, granted_at) VALUES (?, 'reviewer', ?)`).bind(reviewer.id, Date.now()).run();
    const r = s.as(reviewer.auth);
    expect(((await (await s.as(s.u.auth).post(`/submissions/${n}/start`, {})).json()) as any).error.code).toBe("not_reviewer");
    expect((await r.post(`/submissions/${n}/start`, {})).status).toBe(200);
    expect(s.bot.dispatched).toHaveLength(1);
    expect(((await (await r.post(`/submissions/${n}/reject`, {})).json()) as any).error.code).toBe("invalid_body");
    expect((await r.post(`/submissions/${n}/reject`, { note: "It downloads a script at run time." })).status).toBe(200);
    expect(s.bot.archived).toBe(1);
    expect(((await (await call(`/submissions/${n}`)).json()) as any).submission).toMatchObject({ status: "rejected", decision_note: "It downloads a script at run time." });
    expect(((await (await s.as(s.u.auth).post(`/submissions/${n}/withdraw`, {})).json()) as any).error.code).toBe("not_pending");
  });

  it("refuses what is packaged or submitted already", async () => {
    const s = await setup();
    const imp = await draft(s.u, s.upstream);
    expect((await s.as(s.u.auth).post(`/imports/${imp.id}/finish`, { mode: "submit", dockerfile: DOCKERFILE(s.upstream.path) })).status).toBe(201);
    // Someone else submitting the same upstream.
    const other = await user();
    s.fake();
    const imp2 = await draft(other, s.upstream);
    expect(((await (await s.as(other.auth).post(`/imports/${imp2.id}/finish`, { mode: "submit", dockerfile: DOCKERFILE(s.upstream.path) })).json()) as any).error.code).toBe("submission_exists");
    // An upstream that is in the registry already: the seed's holehe-lite names it as its homepage.
    const taken = await setup({ path: "dheeraj/holehe-lite" });
    const imp3 = await draft(taken.u, taken.upstream);
    expect(((await (await taken.as(taken.u.auth).post(`/imports/${imp3.id}/finish`, { mode: "submit", dockerfile: DOCKERFILE(taken.upstream.path) })).json()) as any).error.code).toBe("already_packaged");
  });

  it("checks Dockerfiles against the rules, and every seed wrapper follows them", () => {
    const up = "https://github.com/owner/tool";
    expect(dockerfileChecks(DOCKERFILE("owner/tool"), up)).toMatchObject({ conformant: true, checks: [], refused: [] });
    expect(dockerfileChecks(`FROM alpine:3.22\nADD https://example.org/t /t\nUSER root\n`, up).checks.map((c) => c.code)).toEqual(["dockerfile_root", "dockerfile_add_url", "dockerfile_no_pin"]);
    expect(dockerfileChecks(`FROM alpine:3.22\n${"#".repeat(17 * 1024)}\n`, up).refused.map((c) => c.code)).toEqual(["dockerfile_too_large"]);
    const wrappers = (env as unknown as { TEST_DOCKERFILES: { name: string; homepage: string; dockerfile: string }[] }).TEST_DOCKERFILES;
    const off = wrappers.filter((w) => !dockerfileChecks(w.dockerfile, w.homepage).conformant)
      .map((w) => `${w.name}: ${dockerfileChecks(w.dockerfile, w.homepage).checks.map((c) => c.code).join(",")}`);
    expect(off).toEqual([]);
  });

  it("accepts the Dockerfile templates the import wizard offers", async () => {
    const { dockerfileTemplate } = await import("../../web/src/lib/dockerfile-templates");
    for (const kind of ["go", "pip", "pip_git"] as const) {
      const text = dockerfileTemplate(kind, { repo: "github.com/owner/tool", version: "v1.2.3", command: "tool" });
      expect(dockerfileChecks(text, "https://github.com/owner/tool"), kind).toMatchObject({ conformant: true });
      expect(findPin(text, "https://github.com/owner/tool"), kind).toMatchObject({ kind: "arg", ref: "1.2.3" });
    }
  });
});
