// Tool requests: the checks when one is made, votes, holds and moderation, triagers' decisions and who hears about
// them, linking a request to the package that answers it, token scopes, and the generated list of known repositories.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encrypt, sha256Hex, ulid } from "../src/lib/crypto";
import { requiredScope } from "../src/scopes";
import { knownRepo, linkPublished } from "../src/requests";
import { DROPPED_REASONS, DROPPED_REPOS, OTLITE_REPOS } from "../src/known-repos";
import { call, fakeHosts, testEnv } from "./helpers";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

type Who = { id: string; handle: string; headers: Record<string, string> };

async function person(opts: { ageDays?: number; reviewer?: boolean; github?: boolean } = {}): Promise<Who> {
  const id = ulid();
  const handle = `r${uniq()}`;
  const token = `ot_test_${id}`;
  const stmts = [
    DB().prepare(`INSERT INTO users (id, login, handle, is_reviewer, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, handle, handle, opts.reviewer ? 1 : 0, Date.now() - (opts.ageDays ?? 30) * 86_400_000),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ];
  if (opts.github) {
    stmts.push(DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, access_token_enc, created_at) VALUES (?, ?, 'github', ?, ?, ?, ?)`)
      .bind(ulid(), id, uniq(), handle, await encrypt(env.TOKEN_ENC_KEY, `gho_${handle}`), Date.now()));
  }
  await DB().batch(stmts);
  return { id, handle, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function req(who: Who | null, method: string, path: string, body?: unknown) {
  const res = await call(path, { method, headers: who?.headers ?? {}, body: body === undefined ? undefined : JSON.stringify(body) }, await testEnv());
  return { res, body: (await res.json().catch(() => null)) as any };
}

/** A GitHub repository as the API reports it, with the files it has. */
function githubRepo(path: string, over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const id = Number(uniq());
  const repo = { id, full_name: path, html_url: `https://github.com/${path}`, default_branch: "main", description: "Finds accounts by username", license: { spdx_id: "MIT" },
    private: false, archived: false, stargazers_count: 420, pushed_at: "2026-10-01T00:00:00Z", owner: { login: path.split("/")[0], id: 1, type: "User" }, ...over };
  return {
    id,
    routes: {
      [`GET https://api.github.com/repos/${path}`]: repo,
      [`GET https://api.github.com/repos/${path}/contents/`]: (r: Request) => {
        const file = decodeURIComponent(new URL(r.url).pathname.split("/contents/")[1]!);
        return files[file] === undefined ? null : new Response(files[file]);
      },
    },
  };
}

const inbox = async (who: Who) => (await req(who, "GET", "/me/inbox")).body.items as { kind: string; summary: string; path: string }[];

async function triager(): Promise<Who> {
  const t = await person();
  await DB().prepare(`INSERT INTO community_roles (user_id, role, granted_by, note, granted_at) VALUES (?, 'triager', NULL, 'test', ?)`).bind(t.id, Date.now()).run();
  return t;
}

describe("making a request", () => {
  it("checks the repository, records the request with the requester's vote, and shows it to everyone", async () => {
    const path = `someone/tool${uniq()}`;
    const calls = fakeHosts(githubRepo(path).routes);
    const alice = await person({ github: true });
    const made = await req(alice, "POST", "/requests", { repo: `https://github.com/${path.toLowerCase()}.git`, note: "Finds accounts by username; I'd use it with sherlock." });
    expect(made.res.status).toBe(201);
    expect(made.res.headers.get("cache-control")).toBe("private, no-store");
    expect(made.body.request).toMatchObject({ repo: path, status: "open", votes: 1, license: "MIT", upstream_stars: 420, requested_by: { handle: alice.handle }, indexable: false });
    expect(made.body.url).toBe(`https://otinstaller.com/requests/${made.body.request.number}`);
    // Read as the requester, with their own GitHub token.
    expect(calls.find((c) => c.url.endsWith(`/repos/${path.toLowerCase()}`))).toBeTruthy();
    const number = made.body.request.number;

    const board = await req(null, "GET", "/requests");
    expect(board.res.headers.get("cache-control")).toMatch(/public/);
    expect(board.body.requests.find((r: any) => r.number === number)).toMatchObject({ repo: path, votes: 1 });
    expect(board.body.counts.open).toBeGreaterThanOrEqual(1);
    const page = await req(null, "GET", `/requests/${number}`);
    expect(page.body.request).toMatchObject({ number, note: "Finds accounts by username; I'd use it with sherlock.", decision_note: null });

    // The same repository again is a vote, not a second request.
    const bob = await person();
    const again = await req(bob, "POST", "/requests", { repo: `https://github.com/${path}` });
    expect(again.res.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "request_exists", number, status: "open" });
    expect((await req(bob, "PUT", `/requests/${number}/vote`)).body).toMatchObject({ votes: 2, voted: true });
    expect((await req(bob, "PUT", `/requests/${number}/vote`)).body.votes).toBe(2);
    const viewer = await req(bob, "GET", `/requests/${number}/viewer`);
    expect(viewer.res.headers.get("cache-control")).toBe("private, no-store");
    expect(viewer.body).toMatchObject({ voted: true, is_requester: false, can_decide: false });
    expect((await req(bob, "DELETE", `/requests/${number}/vote`)).body).toMatchObject({ votes: 1, voted: false });
    expect((await req(null, "PUT", `/requests/${number}/vote`)).res.status).toBe(401);
  });

  it("refuses packages already in the registry, tools that publish themselves, and repositories it can't read", async () => {
    const self = `maker/self${uniq()}`;
    fakeHosts({
      ...githubRepo("dheeraj/holehe-lite").routes,
      ...githubRepo(self, {}, { "otinstaller.yaml": "schema: 1\n" }).routes,
      [`GET https://api.github.com/repos/maker/private`]: { ...githubRepo("maker/private").routes["GET https://api.github.com/repos/maker/private"] as object, private: true },
      [`GET https://api.github.com/repos/maker/missing`]: null,
    });
    const p = await person();
    const wrapped = await req(p, "POST", "/requests", { repo: "https://github.com/dheeraj/holehe-lite" });
    expect(wrapped.res.status).toBe(409);
    expect(wrapped.body.error).toMatchObject({ code: "already_in_registry", ref: "dheeraj/holehe-lite" });
    expect((await req(p, "POST", "/requests", { repo: `https://github.com/${self}` })).body.error.code).toBe("upstream_has_manifest");
    expect((await req(p, "POST", "/requests", { repo: "https://github.com/maker/private" })).body.error.code).toBe("repo_not_public");
    expect((await req(p, "POST", "/requests", { repo: "https://github.com/maker/missing" })).body.error.code).toBe("repo_not_found");
    expect((await req(p, "POST", "/requests", { repo: "not a repository" })).body.error.code).toBe("invalid_body");
    expect((await req(null, "POST", "/requests", { repo: "https://github.com/maker/missing" })).res.status).toBe(401);
  });

  it("declines at once what it can't redistribute or is archived, and reads a license GitHub couldn't name", async () => {
    const nc = `lab/nc${uniq()}`;
    const odd = `lab/odd${uniq()}`;
    const old = `lab/old${uniq()}`;
    fakeHosts({
      ...githubRepo(nc, { license: { spdx_id: "CC-BY-NC-4.0" } }).routes,
      ...githubRepo(odd, { license: { spdx_id: "NOASSERTION" } }, { LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy" }).routes,
      ...githubRepo(old, { archived: true }).routes,
    });
    const p = await person();
    const a = await req(p, "POST", "/requests", { repo: `https://github.com/${nc}` });
    expect(a.res.status).toBe(201);
    expect(a.body.request).toMatchObject({ status: "declined", decline_code: "license", license: "CC-BY-NC-4.0" });
    expect(a.body.request.decision_note).toMatch(/CC-BY-NC-4\.0/);
    expect(a.body.notes[0]).toMatch(/recorded as declined/);
    expect((await req(await person(), "PUT", `/requests/${a.body.request.number}/vote`)).body.error.code).toBe("request_closed");
    expect((await req(p, "POST", "/requests", { repo: `https://github.com/${odd}` })).body.request).toMatchObject({ status: "open", license: "MIT" });
    expect((await req(p, "POST", "/requests", { repo: `https://github.com/${old}` })).body.request).toMatchObject({ status: "declined", decline_code: "archived" });
  });

  it("says when otlite has the tool already or the seed survey left it out", async () => {
    fakeHosts(githubRepo("soxoj/maigret").routes);
    const made = await req(await person(), "POST", "/requests", { repo: "https://github.com/soxoj/maigret" });
    expect(made.body.request.otlite).toBe("maigret");
    expect(made.body.notes.join(" ")).toContain("otlite install maigret");
    expect(knownRepo("github", "0xSaikat/FindMe").dropped).toMatch(/prompts for the username/);
    expect(knownRepo("github", "someone/unknown")).toEqual({ otlite: null, dropped: null });
  });

  it("allows five requests a day", async () => {
    fakeHosts({ "GET https://api.github.com/repos/": (r: Request) => {
      const path = new URL(r.url).pathname.replace("/repos/", "");
      return path.includes("/contents/") ? null : githubRepo(path).routes[`GET https://api.github.com/repos/${path}`] as object;
    } });
    const p = await person();
    for (let i = 0; i < 5; i++) expect((await req(p, "POST", "/requests", { repo: `https://github.com/busy/t${uniq()}` })).res.status).toBe(201);
    const sixth = await req(p, "POST", "/requests", { repo: `https://github.com/busy/t${uniq()}` });
    expect(sixth.res.status).toBe(429);
    expect(sixth.body.error.code).toBe("too_many_posts");
  });
});

describe("holds and moderation", () => {
  it("holds requests from new accounts and notes that look like personal data until a triager approves them", async () => {
    const path = `fresh/tool${uniq()}`;
    const leaky = `fresh/leak${uniq()}`;
    fakeHosts({ ...githubRepo(path).routes, ...githubRepo(leaky).routes });
    const fresh = await person({ ageDays: 0 });
    const made = await req(fresh, "POST", "/requests", { repo: `https://github.com/${path}` });
    expect(made.body).toMatchObject({ held: true });
    const number = made.body.request.number;
    expect((await req(null, "GET", `/requests/${number}`)).res.status).toBe(404);
    expect((await req(null, "GET", "/requests?sort=new")).body.requests.some((r: any) => r.number === number)).toBe(false);
    expect((await req(fresh, "GET", `/requests/${number}/viewer`)).body).toMatchObject({ held: true, is_requester: true });
    expect((await req(await person(), "POST", "/requests", { repo: `https://github.com/${leaky}`, note: "My neighbour is jane.doe@protonmail.com" })).body.held).toBe(true);

    const t = await triager();
    const queue = await req(t, "GET", "/moderation/queue?view=held");
    const item = queue.body.items.find((i: any) => i.kind === "request" && i.number === number);
    expect(item).toMatchObject({ title: path, ref: null, hidden_reason: "new_account" });
    expect((await req(await person(), "POST", `/moderation/request/${item.id}`, { action: "approve" })).res.status).toBe(403);
    expect((await req(t, "POST", `/moderation/request/${item.id}`, { action: "redact" })).res.status).toBe(403);
    expect((await req(t, "POST", `/moderation/request/${item.id}`, { action: "approve" })).res.status).toBe(200);
    expect((await req(null, "GET", `/requests/${number}`)).res.status).toBe(200);
    expect((await inbox(fresh)).some((i) => i.kind === "moderation" && i.path === `/requests/${number}`)).toBe(true);
  });
});

describe("decisions", () => {
  it("lets triagers move a request on and tells the requester, and voters when it is published or declined", async () => {
    const path = `team/tool${uniq()}`;
    fakeHosts(githubRepo(path).routes);
    const asker = await person();
    const number = (await req(asker, "POST", "/requests", { repo: `https://github.com/${path}` })).body.request.number;
    const voter = await person();
    await req(voter, "PUT", `/requests/${number}/vote`);
    const t = await triager();

    expect((await req(voter, "POST", `/requests/${number}/status`, { status: "accepted" })).body.error.code).toBe("not_triager");
    expect((await req(t, "POST", `/requests/${number}/status`, { status: "accepted", note: "Fits: one username in, accounts out." })).body).toMatchObject({ status: "accepted" });
    expect((await req(t, "POST", `/requests/${number}/status`, { status: "accepted" })).body.error.code).toBe("request_unchanged");
    expect((await req(null, "GET", `/requests/${number}`)).body.request).toMatchObject({ status: "accepted", decision_note: "Fits: one username in, accounts out.", decided_by: t.handle, indexable: true });
    expect((await inbox(asker)).some((i) => i.summary.includes("was accepted"))).toBe(true);
    expect((await inbox(voter)).length).toBe(0);

    expect((await req(t, "POST", `/requests/${number}/status`, { status: "declined" })).body.error.code).toBe("invalid_body");
    expect((await req(t, "POST", `/requests/${number}/status`, { status: "published", tool: "dheeraj/no-such-tool" })).body.error.code).toBe("invalid_body");
    expect((await req(t, "POST", `/requests/${number}/status`, { status: "published", tool: "dheeraj/whois-lite" })).body).toMatchObject({ status: "published" });
    expect((await req(null, "GET", `/requests/${number}`)).body.request.tool).toBe("dheeraj/whois-lite");
    expect((await inbox(voter)).some((i) => i.summary.includes("which you voted for") && i.summary.includes("published"))).toBe(true);
    expect((await req(null, "GET", "/requests?status=published")).body.requests.some((r: any) => r.number === number)).toBe(true);
  });

  it("lets the requester withdraw their own request and nobody else's", async () => {
    const path = `team/mine${uniq()}`;
    fakeHosts(githubRepo(path).routes);
    const asker = await person();
    const number = (await req(asker, "POST", "/requests", { repo: `https://github.com/${path}` })).body.request.number;
    expect((await req(await person(), "POST", `/requests/${number}/status`, { status: "declined", decline_code: "withdrawn" })).res.status).toBe(403);
    expect((await req(asker, "POST", `/requests/${number}/status`, { status: "declined", decline_code: "not_osint" })).res.status).toBe(403);
    expect((await req(asker, "POST", `/requests/${number}/status`, { status: "declined", decline_code: "withdrawn" })).body).toMatchObject({ status: "declined", decline_code: "withdrawn" });
    // Someone else asking for it again reopens the same request as theirs.
    const next = await person();
    const again = await req(next, "POST", "/requests", { repo: `https://github.com/${path}`, note: "Still useful." });
    expect(again.res.status).toBe(201);
    expect(again.body.request).toMatchObject({ number, status: "open", decline_code: null, note: "Still useful.", requested_by: { handle: next.handle }, votes: 2 });
  });

  it("marks a request published when a package from that repository is published", async () => {
    const path = `acme/whois${uniq()}`;
    const repo = githubRepo(path);
    fakeHosts(repo.routes);
    const number = (await req(await person(), "POST", "/requests", { repo: `https://github.com/${path}` })).body.request.number;
    const toolId = "tool_dheeraj_whois-lite";
    await DB().prepare(`DELETE FROM sources WHERE tool_id = ?`).bind(toolId).run();
    await DB().prepare(`INSERT INTO sources (id, tool_id, provider, project_id, url) VALUES (?, ?, 'github', ?, ?)`).bind(ulid(), toolId, String(repo.id), `https://github.com/${path}`).run();
    await linkPublished(await testEnv(), toolId);
    expect((await req(null, "GET", `/requests/${number}`)).body.request).toMatchObject({ status: "published", tool: "dheeraj/whois-lite" });
  });
});

describe("requests and tokens", () => {
  it("needs the feedback scope to ask and vote, and manage to decide", () => {
    expect(requiredScope("POST", "/v1/requests")).toBe("feedback");
    expect(requiredScope("PUT", "/v1/requests/12/vote")).toBe("feedback");
    expect(requiredScope("DELETE", "/v1/requests/12/vote")).toBe("feedback");
    expect(requiredScope("POST", "/v1/requests/12/status")).toBe("manage");
    expect(requiredScope("GET", "/v1/requests")).toBe("read");
  });

  it("keeps src/known-repos.ts in step with otlite's catalog and seed/candidates.md", () => {
    const want = (env as unknown as { TEST_KNOWN_REPOS: { otlite: Record<string, string>; dropped: Record<string, number>; reasons: string[] } }).TEST_KNOWN_REPOS;
    expect({ otlite: OTLITE_REPOS, dropped: DROPPED_REPOS, reasons: DROPPED_REASONS }, "run `npm run sync:known-repos`").toEqual(want);
  });
});
