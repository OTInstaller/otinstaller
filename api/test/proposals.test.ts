// Change proposals to community wrappers (who may propose, what is checked, the pull request the bot opens, reviews,
// edits, withdrawals, merging and releasing), and a new version's first-week counts on the status line, the versions
// list and the activity feed.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HTTPException } from "hono/http-exception";
import { checkProposal } from "../src/proposals";
import { statusLine } from "../src/community";
import { requiredScope } from "../src/scopes";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, testEnv } from "./helpers";

const GH = "https://api.github.com";
const DB = () => env.DB;
const DAY = 86_400_000;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

type Who = { id: string; handle: string; headers: Record<string, string> };

async function person(opts: { reviewer?: boolean } = {}): Promise<Who> {
  const id = ulid();
  const handle = `p${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, handle, is_reviewer, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, handle, handle, opts.reviewer ? 1 : 0, Date.now() - 30 * DAY),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 't', ?, 1)`).bind(ulid(), id, await sha256Hex(token)),
  ]);
  return { id, handle, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

const yamlFor = (name: string, upstream: string, version: string, runtime: string, extra = "") => `schema: 1
name: ${name}
namespace: osintverse-community
version: ${version}
summary: Finds accounts by username across many sites
readme: README.md
license: MIT
homepage: https://github.com/${upstream}
categories: [username]
inputs:
  - name: username
    type: username
    required: true
outputs:
  - type: account
${runtime}ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: false
${extra}`;

const dockerRuntime = (name: string) => `runtime:
  kind: docker
  image: ghcr.io/osintverse-community/${name}@sha256:${"a".repeat(64)}
  platforms: [linux/amd64, linux/arm64]
  command: ["tool", "{username}"]
  output_format: json
`;

const pipxRuntime = `runtime:
  kind: pipx
  package: py-tool
  package_version: "1.0.0"
  entrypoint: py-tool
  wheel_sha256: ${"c".repeat(64)}
  command: ["py-tool", "{username}"]
  output_format: json
`;

const go = (upstream: string, v: string) => `FROM golang:1.26-alpine AS b\nRUN go install github.com/${upstream}@${v}\nFROM alpine:3.22\nUSER 65534\n`;

/** A published community wrapper whose repository holds `files` on main. */
async function wrapper(opts: { pipx?: boolean } = {}) {
  const name = `w${uniq()}`;
  const upstream = `up${uniq()}/tool`;
  const toolId = ulid();
  const versionId = ulid();
  const version = opts.pipx ? "1.0.0" : "1.2.0";
  const [major, minor, patch] = version.split(".").map(Number);
  const yaml = yamlFor(name, upstream, version, opts.pipx ? pipxRuntime : dockerRuntime(name));
  await DB().batch([
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, community_packaged, repo_url, upstream_url, created_at, updated_at) VALUES (?, 'ns_community', 'tool', ?, 'x', 1, ?, ?, 1, 1)`)
      .bind(toolId, name, `https://github.com/osintverse-community/${name}`, `https://github.com/${upstream}`),
    DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, git_sha, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sha1', 'published', ?, 1)`)
      .bind(versionId, toolId, version, major, minor, patch, JSON.stringify({ name, version, homepage: `https://github.com/${upstream}` }), opts.pipx ? "pipx" : "docker", Date.now() - 30 * DAY),
    DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(versionId, toolId),
    DB().prepare(`INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url) VALUES (?, ?, 'ns_community', 'github', ?, ?, ?)`)
      .bind(ulid(), toolId, uniq(), `osintverse-community/${name}`, `https://github.com/osintverse-community/${name}`),
  ]);
  const files: Record<string, string> = { "otinstaller.yaml": yaml, "README.md": `# ${name}\n\nA community package.\n` };
  if (!opts.pipx) files.Dockerfile = go(upstream, "v1.2.0");
  return { name, upstream, toolId, ref: `osintverse-community/${name}`, repo: `osintverse-community/${name}`, yaml, files };
}

/** The community bot on the wrapper repository: what it reads, commits, opens, edits, merges, closes, tags and dispatches. */
function bot(w: { repo: string; files: Record<string, string> }) {
  const repo = w.repo;
  const did = { commits: [] as { path: string; branch: string; content: string }[], pulls: [] as any[], patched: [] as any[], merged: [] as any[], dispatched: [] as any[], tagged: [] as any[], branches: 0 };
  let pulls = 0;
  const calls = fakeHosts({
    [`POST ${GH}/app/installations/`]: { token: "ghs_bot" },
    [`GET ${GH}/repos/${repo}/contents/`]: (req: Request) => {
      const path = decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!);
      if (w.files[path] === undefined) return null;
      return (req.headers.get("accept") ?? "").includes("raw") ? new Response(w.files[path]) : { sha: "old", type: "file" };
    },
    [`PUT ${GH}/repos/${repo}/contents/`]: async (req: Request) => {
      const b = (await req.json()) as { content: string; branch: string };
      did.commits.push({ path: decodeURIComponent(new URL(req.url).pathname.split("/contents/")[1]!), branch: b.branch, content: atob(b.content) });
      return new Response("{}", { status: 201 });
    },
    [`GET ${GH}/repos/${repo}/git/ref/heads/main`]: { object: { sha: "base123" } },
    [`POST ${GH}/repos/${repo}/git/refs`]: async (req: Request) => {
      const b = (await req.json()) as { ref: string };
      if (b.ref.startsWith("refs/tags/")) return (did.tagged.push(b), new Response("{}", { status: 201 }));
      // The branch exists from the first time the proposal was saved.
      return new Response("{}", { status: did.branches++ ? 422 : 201 });
    },
    [`PATCH ${GH}/repos/${repo}/git/refs/heads/`]: {},
    [`POST ${GH}/repos/${repo}/pulls`]: async (req: Request) => {
      did.pulls.push(await req.json());
      return pulls++ ? new Response("{}", { status: 422 }) : { html_url: `https://github.com/${repo}/pull/9`, number: 9 };
    },
    [`GET ${GH}/repos/${repo}/pulls?state=open`]: [{ html_url: `https://github.com/${repo}/pull/9`, number: 9 }],
    [`PATCH ${GH}/repos/${repo}/pulls/9`]: async (req: Request) => (did.patched.push(await req.json()), {}),
    [`PUT ${GH}/repos/${repo}/pulls/9/merge`]: async (req: Request) => (did.merged.push(await req.json()), { sha: "merged456", merged: true }),
    [`POST ${GH}/repos/${repo}/actions/workflows/`]: async (req: Request) => (did.dispatched.push(await req.json()), new Response(null, { status: 204 })),
  });
  return { did, calls };
}

async function botEnv() {
  const base = await testEnv();
  return { ...base, COMMUNITY_APP_ID: "77", COMMUNITY_INSTALLATION_ID: "555", COMMUNITY_APP_PRIVATE_KEY: base.GITHUB_APP_PRIVATE_KEY };
}

async function req(who: Who | null, method: string, path: string, body?: unknown) {
  const res = await call(path, { method, headers: who?.headers ?? {}, body: body === undefined ? undefined : JSON.stringify(body) }, await botEnv());
  return { res, body: (await res.json().catch(() => null)) as any };
}

async function maintainerOf(toolId: string): Promise<Who> {
  const m = await person();
  await DB().prepare(`INSERT INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'submitter', 1)`).bind(toolId, m.id).run();
  return m;
}

const inbox = async (who: Who) => (await req(who, "GET", "/me/inbox")).body.items as { kind: string; summary: string; path: string }[];

/** The error code an apiError call throws. */
async function refusal(fn: () => unknown): Promise<{ code: string; problems?: { code: string; path?: string }[] }> {
  try {
    fn();
  } catch (e) {
    if (e instanceof HTTPException) return ((await e.getResponse().json()) as any).error;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("checking a change proposal", () => {
  const name = "sherlock";
  const upstream = "sherlock-project/sherlock";
  const yaml = yamlFor(name, upstream, "1.2.0", dockerRuntime(name));
  const current = { "otinstaller.yaml": yaml, Dockerfile: go(upstream, "v1.2.0"), "README.md": "# sherlock\n" };
  const ctx = { upstream: `https://github.com/${upstream}`, latest: "1.2.0", next: "1.2.1" };

  it("keeps only what changed and moves the version past every release", () => {
    const out = checkProposal(current, { "otinstaller.yaml": yaml.replace("across many sites", "across hundreds of sites"), "README.md": current["README.md"] }, ctx);
    expect(Object.keys(out.files)).toEqual(["otinstaller.yaml"]);
    expect(out.version).toBe("1.2.1");
    expect(out.files["otinstaller.yaml"]).toContain("version: 1.2.1\n");
    expect(out.checks).toEqual([{ code: "fields_changed", message: "changes summary" }]);
    // A README change alone still needs a version the package never had.
    const readme = checkProposal(current, { "README.md": "# sherlock\n\nNow with examples.\n" }, ctx);
    expect(Object.keys(readme.files).sort()).toEqual(["README.md", "otinstaller.yaml"]);
    // A version past the latest is kept; a prerelease is not.
    expect(checkProposal(current, { "otinstaller.yaml": yaml.replace("version: 1.2.0", "version: 2.0.0") }, ctx).version).toBe("2.0.0");
    expect(checkProposal(current, { "otinstaller.yaml": yaml.replace("version: 1.2.0", "version: 2.0.0-rc1") }, ctx).version).toBe("1.2.1");
  });

  it("refuses nothing to change, the package's identity, secrets, and a Dockerfile it doesn't have", async () => {
    expect((await refusal(() => checkProposal(current, { "README.md": current["README.md"] }, ctx))).code).toBe("proposal_unchanged");
    const renamed = await refusal(() => checkProposal(current, { "otinstaller.yaml": yaml.replace(`name: ${name}`, "name: other").replace("license: MIT", "license: Apache-2.0") }, ctx));
    expect(renamed.code).toBe("protected_field");
    expect(renamed.problems!.map((p) => p.path)).toEqual(["/name", "/license"]);
    expect((await refusal(() => checkProposal(current, { "otinstaller.yaml": yaml.replace("ghcr.io/osintverse-community/sherlock", "docker.io/evil/sherlock") }, ctx))).code).toBe("protected_field");
    expect((await refusal(() => checkProposal(current, { "README.md": "Set token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 first" }, ctx))).code).toBe("secret_in_proposal");
    expect((await refusal(() => checkProposal({ ...current, Dockerfile: null }, { Dockerfile: "FROM alpine:3.22\n" }, ctx))).code).toBe("no_dockerfile");
    expect((await refusal(() => checkProposal(current, { "otinstaller.yaml": "schema: 1\nname: [" }, ctx))).code).toBe("proposal_invalid");
    expect((await refusal(() => checkProposal(current, { Dockerfile: `${current.Dockerfile}${"#".repeat(17 * 1024)}` }, ctx))).code).toBe("proposal_file_too_large");
  });

  it("tells the reviewer what to look at: changed ethics, Dockerfile rules and personal data", () => {
    const out = checkProposal(current, {
      "otinstaller.yaml": yaml.replace("touches_target: false", "touches_target: true"),
      Dockerfile: current.Dockerfile.replace("USER 65534", "USER root"),
      "README.md": "# sherlock\n\nAsk jane.doe@gmail.com about it.\n",
    }, ctx);
    expect(out.checks.map((c) => c.code).sort()).toEqual(["dockerfile_root", "ethics_changed", "fields_changed", "personal_data"]);
  });
});

describe("change proposals", () => {
  it("lets a maintainer propose a change, a reviewer send it back and approve it, and releases it", async () => {
    const w = await wrapper();
    const { did } = bot(w);
    const maintainer = await maintainerOf(w.toolId);
    const reviewer = await person({ reviewer: true });
    const stranger = await person();

    // What the maintainer starts from; strangers get nothing.
    const start = await req(maintainer, "GET", `/packages/${w.ref}/files`);
    expect(start.body).toMatchObject({ repo: w.repo, builds: true, latest_version: "1.2.0", next_version: "1.2.1", files: { Dockerfile: w.files.Dockerfile, "README.md": w.files["README.md"] } });
    expect(start.res.headers.get("cache-control")).toBe("private, no-store");
    expect((await req(stranger, "GET", `/packages/${w.ref}/files`)).body.error.code).toBe("not_package_maintainer");

    const files = {
      "otinstaller.yaml": w.yaml.replace("across many sites", "across hundreds of sites"),
      "README.md": `${w.files["README.md"]}\nRun it with \`ot run ${w.ref} u:someone\`.\n`,
      Dockerfile: w.files.Dockerfile,
    };
    const refused = await req(stranger, "POST", `/packages/${w.ref}/proposals`, { title: "Better summary", files });
    expect(refused.body.error.code).toBe("not_package_maintainer");
    const made = await req(maintainer, "POST", `/packages/${w.ref}/proposals`, { title: "Better summary and a usage line", note: "The summary undersold it.", files });
    expect(made.res.status).toBe(201);
    expect(made.body.proposal).toMatchObject({
      number: 9, status: "open", version: "1.2.1", files: ["otinstaller.yaml", "README.md"], builds: true, note: "The summary undersold it.",
      proposed_by: { handle: maintainer.handle }, checks: [{ code: "fields_changed", message: "changes summary" }],
    });
    expect(made.body.url).toBe(`https://otinstaller.com/${w.ref}/changes/9`);
    // The bot committed the changed files to the proposal's branch and opened the pull request, then linked its page.
    const branch = did.commits[0]!.branch;
    expect(branch).toMatch(/^otinstaller\/proposal-[0-9a-z]{10}$/);
    expect(did.commits.map((c) => c.path)).toEqual(["otinstaller.yaml", "README.md"]);
    expect(did.commits[0]!.content).toContain("version: 1.2.1\n");
    expect(did.pulls[0]).toMatchObject({ title: "Better summary and a usage line", head: branch, base: "main" });
    expect(did.pulls[0].body).toContain("```text\nThe summary undersold it.\n```");
    expect(did.patched[0].body).toContain(`https://otinstaller.com/${w.ref}/changes/9`);
    expect((await inbox(reviewer)).some((i) => i.kind === "proposal" && i.path === `/${w.ref}/changes/9`)).toBe(true);

    // Anyone can read it.
    const list = await req(null, "GET", `/packages/${w.ref}/proposals`);
    expect(list.res.headers.get("cache-control")).toMatch(/public/);
    expect(list.body.proposals).toEqual([expect.objectContaining({ number: 9, title: "Better summary and a usage line", status: "open" })]);
    expect((await req(null, "GET", "/proposals")).body.proposals.some((p: any) => p.ref === w.ref && p.number === 9)).toBe(true);
    expect((await req(null, "GET", `/packages/${w.ref}/proposals/9`)).body.proposal.note).toBe("The summary undersold it.");
    expect((await req(null, "GET", `/packages/${w.ref}/proposals/10`)).body.error.code).toBe("proposal_not_found");

    // The maintainer can't decide it; a reviewer sends it back with a note.
    expect((await req(maintainer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" })).body.error.code).toBe("not_reviewer");
    expect((await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "changes_requested" })).body.error.code).toBe("invalid_body");
    const back = await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "changes_requested", note: "Mention the sites it skips." });
    expect(back.body.proposal).toMatchObject({ status: "changes_requested", decision_note: "Mention the sites it skips.", reviewed_by: reviewer.handle });
    expect((await inbox(maintainer)).some((i) => i.summary.includes("needs changes"))).toBe(true);

    // The proposer changes it: the branch is rebuilt, the pull request kept, and the reviewer hears about it.
    const viewer = await req(maintainer, "GET", `/packages/${w.ref}/proposals/9/viewer`);
    expect(viewer.body).toMatchObject({ is_proposer: true, can_edit: true, can_withdraw: true, can_review: false });
    expect(Object.keys(viewer.body.files).sort()).toEqual(["README.md", "otinstaller.yaml"]);
    expect((await req(stranger, "PATCH", `/packages/${w.ref}/proposals/9`, { title: "Mine now" })).body.error.code).toBe("forbidden");
    const edited = await req(maintainer, "PATCH", `/packages/${w.ref}/proposals/9`, {
      files: { ...files, "README.md": `${files["README.md"]}\nIt skips sites that need a login.\n`, Dockerfile: w.files.Dockerfile.replace("USER 65534", "USER root") },
    });
    expect(edited.body.proposal).toMatchObject({ status: "open", files: ["otinstaller.yaml", "Dockerfile", "README.md"] });
    expect(edited.body.proposal.checks.map((c: any) => c.code)).toEqual(["fields_changed", "dockerfile_root"]);
    expect(did.commits.filter((c) => c.branch === branch && c.path === "Dockerfile")).toHaveLength(1);
    expect(did.pulls).toHaveLength(2);
    expect((await inbox(reviewer)).some((i) => i.summary.includes("changed their proposal"))).toBe(true);

    // Approved: the bot merges it and the release workflow builds the version.
    const merged = await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" });
    expect(merged.body.proposal).toMatchObject({ status: "merged", released_version: "1.2.1" });
    expect(did.merged).toEqual([{ merge_method: "squash", commit_title: "Better summary and a usage line (#9)" }]);
    expect(did.dispatched).toEqual([{ ref: "main", inputs: { version: "1.2.1" } }]);
    expect((await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" })).body.error.code).toBe("proposal_closed");
    const audit = await DB().prepare(`SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'proposal.%' ORDER BY created_at, rowid`).bind(w.toolId).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["proposal.open", "proposal.request_changes", "proposal.update", "proposal.merge"]);
  });

  it("releases a wrapper without a Dockerfile with a tag, and never lets the proposer review it", async () => {
    const w = await wrapper({ pipx: true });
    const { did } = bot(w);
    const proposer = await person({ reviewer: true });
    const other = await person({ reviewer: true });
    expect((await req(proposer, "POST", `/packages/${w.ref}/proposals`, { title: "Add a Dockerfile", files: { Dockerfile: "FROM alpine:3.22\n" } })).body.error.code).toBe("no_dockerfile");
    const made = await req(proposer, "POST", `/packages/${w.ref}/proposals`, { title: "Explain the output", files: { "README.md": "# py\n\nIt prints one account per site.\n" } });
    expect(made.body.proposal).toMatchObject({ version: "1.0.1", builds: false, files: ["otinstaller.yaml", "README.md"] });
    expect((await req(proposer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" })).body.error.code).toBe("self_review");

    // A tag can only release a version nobody released meanwhile; saving the proposal again moves it on.
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, created_at) VALUES (?, ?, '1.0.1', 1, 0, 1, '{}', 'published', 1)`)
      .bind(ulid(), w.toolId).run();
    expect((await req(other, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" })).body.error.code).toBe("version_taken");
    expect((await req(proposer, "PATCH", `/packages/${w.ref}/proposals/9`, {})).body.proposal.version).toBe("1.0.2");
    const merged = await req(other, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "approve" });
    expect(merged.body.proposal).toMatchObject({ status: "merged", released_version: "1.0.2" });
    expect(did.tagged).toEqual([{ ref: "refs/tags/v1.0.2", sha: "merged456" }]);
    expect(did.dispatched).toEqual([]);
  });

  it("closes the pull request when the proposer withdraws it or a reviewer turns it down", async () => {
    const w = await wrapper();
    const { did } = bot(w);
    const maintainer = await maintainerOf(w.toolId);
    const reviewer = await person({ reviewer: true });
    await req(maintainer, "POST", `/packages/${w.ref}/proposals`, { title: "Typo in the README", files: { "README.md": "# fixed\n" } });
    expect((await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "reject" })).body.error.code).toBe("invalid_body");
    expect((await req(reviewer, "POST", `/packages/${w.ref}/proposals/9/review`, { decision: "reject", note: "The README is generated upstream." })).body.proposal.status).toBe("rejected");
    expect(did.patched.at(-1)).toEqual({ state: "closed" });
    expect((await req(maintainer, "DELETE", `/packages/${w.ref}/proposals/9`)).body.error.code).toBe("proposal_closed");

    // A second proposal (the fake reuses #9 for it) is withdrawn by its proposer.
    await DB().prepare(`DELETE FROM change_proposals WHERE tool_id = ?`).bind(w.toolId).run();
    await req(maintainer, "POST", `/packages/${w.ref}/proposals`, { title: "Typo in the README", files: { "README.md": "# fixed again\n" } });
    expect((await req(reviewer, "DELETE", `/packages/${w.ref}/proposals/9`)).body.error.code).toBe("forbidden");
    expect((await req(maintainer, "DELETE", `/packages/${w.ref}/proposals/9`)).body).toEqual({ number: 9, status: "withdrawn" });
    expect(did.patched.at(-1)).toEqual({ state: "closed" });
  });

  it("takes no proposals for packages published from their own repository, and limits each person", async () => {
    expect((await req(null, "GET", "/packages/dheeraj/holehe-lite/proposals")).body.error.code).toBe("not_a_wrapper");
    const w = await wrapper();
    bot(w);
    const maintainer = await maintainerOf(w.toolId);
    for (let i = 0; i < 3; i++) {
      await DB().prepare(`INSERT INTO change_proposals (id, tool_id, pr_number, url, branch, proposer_id, title, files_json, version, created_at, updated_at) VALUES (?, ?, ?, 'u', 'b', ?, 't', '{}', '1.2.1', 1, 1)`)
        .bind(ulid(), w.toolId, 100 + i, maintainer.id).run();
    }
    expect((await req(maintainer, "POST", `/packages/${w.ref}/proposals`, { title: "One more change", files: { "README.md": "# x\n" } })).body.error.code).toBe("too_many_proposals");

    // Sending a proposal back needs no GitHub, so it works while the community bot isn't set up; merging doesn't.
    const reviewer = await person({ reviewer: true });
    const noBot = async (body: unknown) => {
      const res = await call(`/packages/${w.ref}/proposals/100/review`, { method: "POST", headers: reviewer.headers, body: JSON.stringify(body) }, await testEnv());
      return (await res.json()) as any;
    };
    expect((await noBot({ decision: "changes_requested", note: "Split it in two." })).proposal.status).toBe("changes_requested");
    await DB().prepare(`UPDATE change_proposals SET status = 'open' WHERE tool_id = ? AND pr_number = 100`).bind(w.toolId).run();
    expect((await noBot({ decision: "approve" })).error.code).toBe("community_bot_missing");
  });

  it("needs the publish scope to propose and edit, and manage to review and withdraw", () => {
    expect(requiredScope("POST", "/v1/packages/a/b/proposals")).toBe("publish");
    expect(requiredScope("PATCH", "/v1/packages/a/b/proposals/9")).toBe("publish");
    expect(requiredScope("POST", "/v1/packages/a/b/proposals/9/review")).toBe("manage");
    expect(requiredScope("DELETE", "/v1/packages/a/b/proposals/9")).toBe("manage");
    expect(requiredScope("GET", "/v1/packages/a/b/files")).toBe("read");
  });
});

describe("a new version's first week", () => {
  it("says when the latest version came out and what people said since", () => {
    const now = Date.now();
    const base = { health: "healthy", checked_at: now, works: 0, broken: 0, platforms: [], open_broken: 0, version: "1.3.0" };
    expect(statusLine({ ...base, released_at: now - 2 * DAY }, now).text).toBe("Passed the registry's health check today; 1.3.0 came out 2 days ago; nobody has said yet whether it works.");
    expect(statusLine({ ...base, works: 2, broken: 1, platforms: ["linux/amd64"], released_at: now - DAY }, now).text)
      .toBe("Passed the registry's health check today; 1.3.0 came out yesterday: works for 2 people, broken for 1 person (linux/amd64).");
    // After the first week the line goes back to the last 30 days.
    expect(statusLine({ ...base, works: 2, released_at: now - 8 * DAY }, now).text).toBe("Passed the registry's health check today; 1.3.0 works for 2 people in the last 30 days.");
  });

  it("shows the counts beside the version before it, in the versions list and in the activity feed", async () => {
    const name = `fw${uniq()}`;
    const toolId = ulid();
    const [old, fresh] = [ulid(), ulid()];
    const now = Date.now();
    await DB().batch([
      DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, 'ns_community', 'tool', ?, 'First-week test tool', 1, 1)`).bind(toolId, name),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.0.0', 1, 0, 0, '{}', 'published', ?, 1)`).bind(old, toolId, now - 20 * DAY),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.1.0', 1, 1, 0, '{}', 'published', ?, 1)`).bind(fresh, toolId, now - 2 * DAY),
      DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(fresh, toolId),
      DB().prepare(`INSERT INTO audit_log (id, actor_kind, action, target_kind, target_id, created_at) VALUES (?, 'system', 'version.published', 'version', ?, ?)`).bind(ulid(), fresh, now - 2 * DAY),
    ]);
    const people = await Promise.all([person(), person(), person(), person()]);
    const confirm = (who: Who, version: string, result: string, platform: string) =>
      DB().prepare(`INSERT INTO confirmations (id, tool_id, version_id, user_id, result, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(ulid(), toolId, version, who.id, result, platform, now - DAY);
    await DB().batch([
      confirm(people[0]!, old, "works", "linux/amd64"), confirm(people[1]!, old, "works", "darwin/arm64"),
      confirm(people[0]!, fresh, "works", "linux/amd64"), confirm(people[2]!, fresh, "broken", "linux/amd64"), confirm(people[3]!, fresh, "broken", "windows/amd64"),
    ]);
    const ref = `osintverse-community/${name}`;

    const status = (await req(null, "GET", `/tools/${ref}/status`)).body;
    expect(status.line.text).toContain("1.1.0 came out 2 days ago: works for 1 person, broken for 2 people (linux/amd64)");
    expect(status.new_version).toMatchObject({ version: "1.1.0", works: 1, broken: 2, previous: { version: "1.0.0", works: 2, broken: 0 } });
    expect(status.new_version.ends_at).toBe(now - 2 * DAY + 7 * DAY);

    const versions = (await req(null, "GET", `/tools/${ref}/versions`)).body.versions;
    expect(versions.find((v: any) => v.version === "1.1.0").first_week).toMatchObject({ works: 1, broken: 2 });
    expect(versions.find((v: any) => v.version === "1.0.0").first_week).toBeUndefined();

    const activity = (await req(null, "GET", "/activity?namespace=osintverse-community&limit=100")).body.events;
    expect(activity.find((e: any) => e.ref === ref && e.type === "published").first_week).toMatchObject({ works: 1, broken: 2 });
  });
});
