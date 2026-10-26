// Community: issues and comments on packages, holds and screening, triage roles, locks and edits, confirmations,
// flags and moderation, counters, rate limits, system issues, failed runs and problems reported without a sign-in, and
// token scopes.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { announceVersion, closeSystemIssue, fileSystemIssue, REDACTED, refreshAllHealth, renderPost, screen } from "../src/community";
import { requiredScope } from "../src/scopes";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call } from "./helpers";

const DB = () => env.DB;
const TOOL = "dheeraj/holehe-lite";
const TOOL_ID = "tool_dheeraj_holehe-lite";
let n = 0;
const uniq = () => `${Date.now() % 1e6}${++n}`;

type Who = { id: string; handle: string; headers: Record<string, string> };

/** A signed-in person. Accounts are a month old unless `ageDays` says otherwise. */
async function person(opts: { ageDays?: number; admin?: boolean; reviewer?: boolean; member?: string; scopes?: string } = {}): Promise<Who> {
  const id = ulid();
  const handle = `p${uniq()}`;
  const token = `ot_test_${id}`;
  const created = Date.now() - (opts.ageDays ?? 30) * 86_400_000;
  const stmts = [
    DB().prepare(`INSERT INTO users (id, login, handle, is_admin, is_reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, handle, handle, opts.admin ? 1 : 0, opts.reviewer ? 1 : 0, created),
    opts.scopes
      ? DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES (?, ?, 'test', ?, ?, 1, ?)`).bind(ulid(), id, await sha256Hex(token), opts.scopes, Date.now())
      : DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ];
  if (opts.member) stmts.push(DB().prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(opts.member, id));
  await DB().batch(stmts);
  return { id, handle, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

async function req(who: Who | null, method: string, path: string, body?: unknown) {
  const res = await call(path, { method, headers: who?.headers ?? {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return { res, body: (await res.json().catch(() => null)) as any };
}

const newIssue = (who: Who, over: Record<string, unknown> = {}) =>
  req(who, "POST", `/tools/${TOOL}/issues`, { kind: "broken", title: "Fails on every address", body: "It exits with 1 straight away on version 1.2.0.", version: "1.2.0", platform: "linux/amd64", engine: "docker", exit_code: 1, ...over });

describe("issues and comments", () => {
  it("lets people open issues and comment, and shows them to everyone", async () => {
    const alice = await person();
    const created = await newIssue(alice);
    expect(created.res.status).toBe(201);
    expect(created.body).toMatchObject({ ref: TOOL, moderation: "visible" });
    const number = created.body.number;

    const list = await req(null, "GET", `/tools/${TOOL}/issues`);
    expect(list.res.headers.get("cache-control")).toMatch(/public/);
    expect(list.body.issues.find((i: any) => i.number === number)).toMatchObject({ kind: "broken", status: "open", author: { handle: alice.handle }, platform: "linux/amd64" });

    const bob = await person();
    expect((await req(bob, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Same here on macOS with Podman." })).body).toMatchObject({ moderation: "visible" });
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${number}`);
    expect(thread.body.issue).toMatchObject({ number, comments: 1, engine: "docker", exit_code: 1, indexable: false });
    expect(thread.body.issue.body_html).toContain("<p>It exits with 1");
    expect(thread.body.comments).toHaveLength(1);
    expect(thread.body.comments[0]).toMatchObject({ author: { handle: bob.handle }, role: null });

    const viewer = await req(alice, "GET", `/tools/${TOOL}/issues/${number}/viewer`);
    expect(viewer.res.headers.get("cache-control")).toBe("private, no-store");
    expect(viewer.body).toMatchObject({ is_author: true, can_edit_issue: true, can_triage: false, subscribed: true });
  });

  it("validates what people send", async () => {
    const p = await person();
    expect((await newIssue(p, { kind: "rant" })).res.status).toBe(400);
    expect((await newIssue(p, { title: "no" })).res.status).toBe(400);
    expect((await newIssue(p, { engine: "vm" })).res.status).toBe(400);
    expect((await req(p, "POST", `/tools/dheeraj/no-such-tool/issues`, { kind: "broken", title: "Fails", body: "x".repeat(20) })).res.status).toBe(404);
    expect((await req(null, "POST", `/tools/${TOOL}/issues`, { kind: "broken", title: "Fails", body: "x".repeat(20) })).res.status).toBe(401);
  });

  it("holds posts from new accounts, posts that look like personal data, and first posts with links", async () => {
    const fresh = await person({ ageDays: 0 });
    expect((await newIssue(fresh)).body.moderation).toBe("held");
    const leaky = await person();
    expect((await newIssue(leaky, { body: "It fails for jane.doe@protonmail.com and 81.2.69.160, please look." })).body.moderation).toBe("held");
    const linker = await person();
    const held = await newIssue(linker, { body: "Broken, see https://evil.example.net/thread for details." });
    expect(held.body.moderation).toBe("held");
    // Held posts are not public until a moderator approves them.
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${held.body.number}`)).res.status).toBe(404);
    const triager = await person();
    const admin = await person({ admin: true });
    await req(admin, "POST", "/admin/community/roles", { handle: triager.handle, role: "triager", note: "helps with broken reports" });
    const queue = await req(triager, "GET", "/moderation/queue?view=held");
    const item = queue.body.items.find((i: any) => i.kind === "issue" && i.number === held.body.number);
    expect(item).toMatchObject({ ref: TOOL, hidden_reason: "first_post_with_links" });
    expect((await req(triager, "POST", `/moderation/issue/${item.id}`, { action: "approve" })).res.status).toBe(200);
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${held.body.number}`)).res.status).toBe(200);
  });

  it("shows new people's links as text and marks others nofollow", () => {
    expect(renderPost("see [docs](https://example.com/docs)", true)).toContain("docs (https://example.com/docs)");
    const linked = renderPost("see [docs](https://example.com/docs)");
    expect(linked).toContain('<a href="https://example.com/docs" rel="nofollow ugc noopener noreferrer">docs</a>');
    expect(linked.match(/rel=/g)).toHaveLength(1);
    expect(renderPost("<script>alert(1)</script> ![x](https://example.com/a.png)")).not.toMatch(/<script|<img/);
    expect(screen("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("secret");
    expect(screen("try 192.0.2.10 or 10.0.0.1")).toEqual([]);
  });
});

describe("triage", () => {
  it("lets maintainers, triagers and staff triage, and authors close their own issue as fixed", async () => {
    const author = await person();
    const number = (await newIssue(author)).body.number;
    const stranger = await person();
    const status = (who: Who, s: string, extra = {}) => req(who, "POST", `/tools/${TOOL}/issues/${number}/status`, { status: s, ...extra });
    expect((await status(stranger, "confirmed")).body.error.code).toBe("not_triager");
    expect((await status(author, "wont_fix")).res.status).toBe(403);
    const maintainer = await person({ member: "ns_dheeraj" });
    expect((await status(maintainer, "confirmed")).res.status).toBe(200);
    // A maintainer's reply makes the issue indexable.
    await req(maintainer, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Confirmed, a fix is coming." });
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${number}`);
    expect(thread.body.issue.indexable).toBe(true);
    expect(thread.body.comments.at(-1).role).toBe("maintainer");
    expect((await status(maintainer, "duplicate", { duplicate_of: 999 })).res.status).toBe(400);
    expect((await status(author, "fixed")).res.status).toBe(200);
    const closed = await req(null, "GET", `/tools/${TOOL}/issues?status=closed`);
    expect(closed.body.issues.some((i: any) => i.number === number && i.status === "fixed")).toBe(true);
  });

  it("keeps the package's open broken and outdated counts", async () => {
    const p = await person();
    const maintainer = await person({ member: "ns_dheeraj" });
    const before = (await DB().prepare(`SELECT open_broken, open_outdated FROM tools WHERE id = ?`).bind(TOOL_ID).first<{ open_broken: number; open_outdated: number }>())!;
    const b = (await newIssue(p)).body.number;
    await newIssue(p, { kind: "outdated", title: "Upstream released 2.0", body: "" });
    let now = (await DB().prepare(`SELECT open_broken, open_outdated FROM tools WHERE id = ?`).bind(TOOL_ID).first<{ open_broken: number; open_outdated: number }>())!;
    expect(now).toEqual({ open_broken: before.open_broken + 1, open_outdated: before.open_outdated + 1 });
    await req(maintainer, "POST", `/tools/${TOOL}/issues/${b}/status`, { status: "fixed", fixed_in: "1.2.1" });
    now = (await DB().prepare(`SELECT open_broken, open_outdated FROM tools WHERE id = ?`).bind(TOOL_ID).first<{ open_broken: number; open_outdated: number }>())!;
    expect(now.open_broken).toBe(before.open_broken);
  });

  it("locks threads to everyone but triagers, and keeps edits to the first day", async () => {
    const author = await person();
    const number = (await newIssue(author)).body.number;
    const maintainer = await person({ member: "ns_dheeraj" });
    await req(maintainer, "POST", `/tools/${TOOL}/issues/${number}/lock`, { locked: true });
    expect((await req(author, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "still broken" })).body.error.code).toBe("issue_locked");
    expect((await req(maintainer, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Locked while we fix it." })).res.status).toBe(201);

    expect((await req(author, "PATCH", `/tools/${TOOL}/issues/${number}`, { title: "Fails on every address, since 1.2.0" })).res.status).toBe(200);
    expect((await req(maintainer, "PATCH", `/tools/${TOOL}/issues/${number}`, { title: "Changed by someone else" })).res.status).toBe(403);
    await DB().prepare(`UPDATE issues SET created_at = ? WHERE tool_id = ? AND number = ?`).bind(Date.now() - 2 * 86_400_000, TOOL_ID, number).run();
    expect((await req(author, "PATCH", `/tools/${TOOL}/issues/${number}`, { title: "Too late to change this" })).body.error.code).toBe("edit_window_closed");
    expect((await req(author, "DELETE", `/tools/${TOOL}/issues/${number}`)).body).toEqual({ deleted: true });
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${number}`)).body.issue).toMatchObject({ deleted: true, body_html: "" });
  });

  it("stops someone posting for a while after a moderator's timeout", async () => {
    const admin = await person({ admin: true });
    const troll = await person();
    expect((await req(admin, "POST", `/moderation/users/${troll.handle}/timeout`, { days: 3, reason: "spam" })).res.status).toBe(200);
    expect((await newIssue(troll)).body.error.code).toBe("posting_blocked");
  });
});

describe("confirmations", () => {
  it("counts one answer per person, version and platform, and a broken answer as a me too", async () => {
    const p = await person();
    const put = (body: unknown) => req(p, "PUT", `/tools/${TOOL}/confirmations`, body);
    const one = await put({ result: "works", platform: "linux/amd64" });
    expect(one.body).toMatchObject({ version: expect.any(String) });
    const works = one.body.works;
    expect((await put({ result: "works", platform: "linux/amd64" })).body.works).toBe(works);
    expect((await put({ result: "works", platform: "darwin/arm64" })).body.works).toBe(works + 1);
    expect((await put({ result: "maybe" })).res.status).toBe(400);
    expect((await put({ result: "works", version: "0.0.1" })).res.status).toBe(404);

    const number = (await newIssue(await person())).body.number;
    await put({ result: "broken", platform: "windows/amd64", issue: number });
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${number}`)).body.issue.me_too).toBe(1);
  });
});

describe("flags and moderation", () => {
  it("hides a post at once on a personal-data flag, and lets only staff redact", async () => {
    const author = await person();
    const number = (await newIssue(author)).body.number;
    const comment = (await req(author, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Here is what it printed for my test." })).body;
    const flagger = await person();
    const flag = await req(flagger, "POST", "/flags", { target_kind: "comment", target_id: comment.id, reason: "personal_data", note: "has someone's address" });
    expect(flag.body).toMatchObject({ hidden: true });
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${number}`)).body.comments).toHaveLength(0);

    const triager = await person();
    await req(await person({ admin: true }), "POST", "/admin/community/roles", { handle: triager.handle, role: "triager", note: "moderation help" });
    expect((await req(triager, "GET", "/moderation/queue?view=flags")).body.flags.some((f: any) => f.target_id === comment.id)).toBe(true);
    expect((await req(triager, "POST", `/moderation/comment/${comment.id}`, { action: "redact" })).res.status).toBe(403);
    const staff = await person({ reviewer: true });
    expect((await req(staff, "POST", `/moderation/comment/${comment.id}`, { action: "redact" })).res.status).toBe(200);
    expect(await DB().prepare(`SELECT body_md FROM issue_comments WHERE id = ?`).bind(comment.id).first()).toEqual({ body_md: REDACTED });
    expect(await DB().prepare(`SELECT status FROM content_flags WHERE target_id = ?`).bind(comment.id).first()).toEqual({ status: "upheld" });
  });

  it("lets maintainers hide comments on their package's issues, but not issues", async () => {
    const number = (await newIssue(await person())).body.number;
    const issueId = (await DB().prepare(`SELECT id FROM issues WHERE tool_id = ? AND number = ?`).bind(TOOL_ID, number).first<{ id: string }>())!.id;
    const comment = (await req(await person(), "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Off-topic advert for something." })).body;
    const maintainer = await person({ member: "ns_dheeraj" });
    expect((await req(maintainer, "POST", `/moderation/comment/${comment.id}`, { action: "hide", reason: "spam" })).res.status).toBe(200);
    expect((await req(maintainer, "POST", `/moderation/issue/${issueId}`, { action: "hide" })).res.status).toBe(403);
  });
});

describe("limits, roles and scopes", () => {
  it("allows a few issues a day per person", async () => {
    const p = await person();
    for (let i = 0; i < 5; i++) expect((await newIssue(p, { title: `Fails in case ${i}` })).res.status).toBe(201);
    const sixth = await newIssue(p);
    expect(sixth.res.status).toBe(429);
    expect(sixth.body.error.code).toBe("too_many_posts");
  });

  it("lets admins grant and revoke roles, which /me shows", async () => {
    const admin = await person({ admin: true });
    const p = await person();
    expect((await req(p, "POST", "/admin/community/roles", { handle: p.handle, role: "triager", note: "me" })).res.status).toBe(403);
    expect((await req(admin, "POST", "/admin/community/roles", { handle: p.handle, role: "reviewer" })).res.status).toBe(400);
    expect((await req(admin, "POST", "/admin/community/roles", { handle: p.handle, role: "reviewer", note: "reviews submissions" })).res.status).toBe(201);
    expect((await req(p, "GET", "/me")).body).toMatchObject({ handle: p.handle, community_roles: ["reviewer", "triager"] });
    expect((await req(admin, "GET", "/admin/community/roles")).body.roles.some((r: any) => r.handle === p.handle && r.granted_by === admin.handle)).toBe(true);
    await req(admin, "DELETE", `/admin/community/roles/${p.handle}/reviewer`);
    expect((await req(p, "GET", "/me")).body.community_roles).toEqual([]);
  });

  it("needs the feedback scope to post and manage to triage", async () => {
    expect(requiredScope("POST", `/v1/tools/${TOOL}/issues`)).toBe("feedback");
    expect(requiredScope("POST", `/v1/tools/${TOOL}/issues/3/comments`)).toBe("feedback");
    expect(requiredScope("PUT", `/v1/tools/${TOOL}/confirmations`)).toBe("feedback");
    expect(requiredScope("PATCH", "/v1/comments/abc")).toBe("feedback");
    expect(requiredScope("POST", "/v1/flags")).toBe("feedback");
    expect(requiredScope("POST", `/v1/tools/${TOOL}/issues/3/status`)).toBe("manage");
    expect(requiredScope("POST", "/v1/moderation/comment/abc")).toBe("manage");
    const reader = await person({ scopes: "read" });
    expect((await newIssue(reader)).body.error.code).toBe("insufficient_scope");
  });
});

describe("system issues", () => {
  it("opens one issue per dedupe key, updates it while open and closes it with a note", async () => {
    const a = await fileSystemIssue(env as any, TOOL_ID, "outdated", { title: "Upstream released 2.0.0", markdown: "Released 3 days ago.", version: "2.0.0" }, "outdated:test", "upstream_watch");
    const b = await fileSystemIssue(env as any, TOOL_ID, "outdated", { title: "Upstream released 2.1.0", markdown: "Released today.", version: "2.1.0" }, "outdated:test", "upstream_watch");
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ id: a.id, number: a.number, created: false });
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${a.number}`);
    expect(thread.body.issue).toMatchObject({ title: "Upstream released 2.1.0", author: { system: true } });
    expect(await closeSystemIssue(env as any, TOOL_ID, "outdated:test", "fixed", "Version 2.1.0 of the wrapper is published.")).toBe(true);
    expect(await closeSystemIssue(env as any, TOOL_ID, "outdated:test", "fixed")).toBe(false);
    const after = await req(null, "GET", `/tools/${TOOL}/issues/${a.number}`);
    expect(after.body.issue.status).toBe("fixed");
    expect(after.body.comments.at(-1)).toMatchObject({ author: { system: true } });
  });

  it("asks open broken issues whether a new version fixes them", async () => {
    const number = (await newIssue(await person())).body.number;
    await announceVersion(env as any, TOOL_ID, "9.9.9");
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${number}`);
    expect(thread.body.comments.at(-1).body_html).toContain("Version 9.9.9 is out");
  });

  it("turns a private broken report into a public issue written by a reviewer", async () => {
    const reportId = ulid();
    await DB().prepare(`INSERT INTO reports (id, tool_id, reporter_id, reason, details, created_at) VALUES (?, ?, NULL, 'broken', 'my private details', ?)`).bind(reportId, TOOL_ID, Date.now()).run();
    const reviewer = await person({ reviewer: true });
    const out = await req(reviewer, "POST", `/admin/reports/${reportId}/publish-issue`, { title: "Times out on large inputs", body: "Several people report a timeout after 5 minutes." });
    expect(out.res.status).toBe(201);
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${out.body.number}`);
    expect(JSON.stringify(thread.body)).not.toContain("my private details");
    expect(await DB().prepare(`SELECT status, action FROM reports WHERE id = ?`).bind(reportId).first()).toEqual({ status: "actioned", action: "published_issue" });
  });

  it("lists open problems across the registry on the board", async () => {
    await newIssue(await person(), { title: "Board entry for the test" });
    const board = await req(null, "GET", "/issues");
    expect(board.body.issues.some((i: any) => i.ref === TOOL && i.title === "Board entry for the test")).toBe(true);
    expect((await req(null, "GET", "/issues?needs=confirmation")).body.issues.every((i: any) => i.kind === "broken" && i.status === "open")).toBe(true);
  });
});

describe("community status", () => {
  it("puts confirmations and open issues in one line", async () => {
    const p = await person();
    await req(p, "PUT", `/tools/${TOOL}/confirmations`, { result: "works", platform: "linux/amd64" });
    const s = await req(null, "GET", `/tools/${TOOL}/status`);
    expect(s.res.headers.get("cache-control")).toMatch(/public.*max-age=300/);
    expect(s.body.line.text).toMatch(/works for \d+ (person|people)[^(]*\([^)]*linux\/amd64/);
    expect(s.body.health).toEqual({ status: expect.any(String), checked_at: expect.any(Number) });
    const detail = await req(null, "GET", `/tools/${TOOL}`);
    expect(detail.body.community).toEqual({ open_broken: expect.any(Number), open_outdated: expect.any(Number) });
  });

  it("says failing, mixed, working or unknown from the facts", async () => {
    const { statusLine } = await import("../src/community");
    const now = Date.now();
    const base = { works: 0, broken: 0, platforms: [], open_broken: 0, version: "1.0.0" };
    expect(statusLine(base, now)).toEqual({ state: "unknown", text: "Nobody has said in the last 30 days whether 1.0.0 works." });
    expect(statusLine({ ...base, works: 2 }, now)).toEqual({ state: "working", text: "1.0.0 works for 2 people in the last 30 days." });
    expect(statusLine({ ...base, broken: 3, works: 1 }, now).state).toBe("failing");
    expect(statusLine({ ...base, broken: 1, works: 1 }, now).state).toBe("mixed");
    expect(statusLine({ ...base, works: 2, open_broken: 1 }, now)).toMatchObject({ state: "failing", text: expect.stringContaining("1 open broken issue") });
  });

  it("marks a package healthy or possibly broken from what people report", async () => {
    const toolId = ulid();
    const name = `health${uniq()}`;
    const [old, latest] = [ulid(), ulid()];
    await DB().batch([
      DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, 'ns_community', 'tool', ?, 'Health test tool', 1, 1)`).bind(toolId, name),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.0.0', 1, 0, 0, '{}', 'published', 1, 1)`).bind(old, toolId),
      DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '1.1.0', 1, 1, 0, '{}', 'published', 2, 2)`).bind(latest, toolId),
      DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(latest, toolId),
    ]);
    const ref = `osintverse-community/${name}`;
    const health = async () => (await DB().prepare(`SELECT health_status, health_checked_at FROM tools WHERE id = ?`).bind(toolId).first<{ health_status: string; health_checked_at: number | null }>())!;
    const [a, b, c] = await Promise.all([person(), person(), person()]);

    // Reports about an older version don't count.
    await req(a, "PUT", `/tools/${ref}/confirmations`, { result: "broken", version: "1.0.0", platform: "linux/amd64" });
    await req(b, "PUT", `/tools/${ref}/confirmations`, { result: "broken", version: "1.0.0", platform: "linux/amd64" });
    expect((await health()).health_status).toBe("unknown");

    await req(a, "PUT", `/tools/${ref}/confirmations`, { result: "works", platform: "linux/amd64" });
    expect(await health()).toEqual({ health_status: "healthy", health_checked_at: expect.any(Number) });
    expect((await req(null, "GET", `/tools/${ref}`)).body.health).toBe("healthy");

    // Two people who say it is broken outnumber one who says it works.
    await req(b, "PUT", `/tools/${ref}/confirmations`, { result: "broken", platform: "linux/amd64" });
    expect((await health()).health_status).toBe("healthy");
    await req(c, "PUT", `/tools/${ref}/confirmations`, { result: "broken", platform: "darwin/arm64" });
    expect((await health()).health_status).toBe("broken");
    expect((await req(null, "GET", `/tools/${ref}/status`)).body.line.state).toBe("failing");
    await req(c, "PUT", `/tools/${ref}/confirmations`, { result: "works", platform: "darwin/arm64" });
    expect((await health()).health_status).toBe("healthy");

    // An open broken issue makes it possibly broken until it is closed.
    await fileSystemIssue(env as any, toolId, "broken", { title: "Several reports of it failing", markdown: "Failed runs.", version: "1.1.0" }, "health:test", "run_signals");
    expect((await health()).health_status).toBe("broken");
    await closeSystemIssue(env as any, toolId, "health:test", "fixed");
    expect((await health()).health_status).toBe("healthy");

    // What people said more than 30 days ago stops counting at the nightly recount.
    await DB().prepare(`UPDATE confirmations SET created_at = ? WHERE tool_id = ?`).bind(Date.now() - 31 * 86_400_000, toolId).run();
    await refreshAllHealth(env as any);
    expect(await health()).toEqual({ health_status: "unknown", health_checked_at: null });
  });
});

describe("notifications", () => {
  const inbox = async (who: Who) => (await req(who, "GET", "/me/inbox")).body;
  const withEmail = async (opts: Parameters<typeof person>[0] = {}) => {
    const p = await person(opts);
    await DB().prepare(`UPDATE users SET email = ? WHERE id = ?`).bind(`${p.handle}@example.com`, p.id).run();
    return p;
  };

  it("tells maintainers about new issues and followers about replies, never the person who acted", async () => {
    const maintainer = await withEmail({ member: "ns_dheeraj" });
    const author = await withEmail();
    const number = (await newIssue(author, { title: "Notifies maintainers when opened" })).body.number;
    expect((await inbox(maintainer)).items[0]).toMatchObject({ kind: "issue_opened", summary: expect.stringContaining("New broken issue on dheeraj/holehe-lite"), path: `/${TOOL}/issues/${number}` });
    expect((await inbox(author)).items.some((i: any) => i.path === `/${TOOL}/issues/${number}`)).toBe(false);
    await req(maintainer, "POST", `/tools/${TOOL}/issues/${number}/comments`, { body: "Looking into it now." });
    const a = await inbox(author);
    expect(a.items[0]).toMatchObject({ kind: "comment", summary: expect.stringContaining(`${maintainer.handle} replied`) });
    expect((await req(author, "GET", "/me")).body.unread).toBeGreaterThan(0);
    await req(author, "POST", "/me/inbox/read", {});
    expect((await inbox(author)).unread).toBe(0);
  });

  it("emails what is waiting once per person, with a one-click unsubscribe, and respects preferences", async () => {
    const { deliverInbox, unsubscribeUrl } = await import("../src/inbox");
    const { fakeHosts } = await import("./helpers");
    const calls = fakeHosts({ "POST https://api.resend.com/emails": { id: "email" } });
    const maintainer = await withEmail({ member: "ns_dheeraj" });
    const quiet = await withEmail({ member: "ns_dheeraj" });
    expect((await req(quiet, "PUT", "/me/email-prefs", { owner_issues: "off" })).body).toEqual({ community: "immediate", owner_issues: "off", releases: "immediate", lifecycle: "immediate", security: "immediate" });
    expect((await req(quiet, "PUT", "/me/email-prefs", { owner_issues: "sometimes" })).res.status).toBe(400);
    const author = await person();
    await newIssue(author, { title: "First of two for the email" });
    await newIssue(author, { title: "Second of two for the email" });
    await deliverInbox(env as any, "immediate", Date.now() + 5 * 60_000);
    const mails = calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body));
    const mine = mails.filter((m) => m.to.includes(`${maintainer.handle}@example.com`));
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/updates on OTInstaller/);
    expect(mine[0].text).toContain("Second of two for the email");
    expect(mine[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mails.some((m) => m.to.includes(`${quiet.handle}@example.com`))).toBe(false);
    // Nothing is sent twice.
    const before = calls.length;
    await deliverInbox(env as any, "immediate", Date.now() + 6 * 60_000);
    expect(calls.filter((c, i) => i >= before && c.url === "https://api.resend.com/emails" && JSON.parse(c.body).to.includes(`${maintainer.handle}@example.com`))).toHaveLength(0);

    // The link in the header turns the preference off; a wrong signature is refused, a GET only shows the page.
    const url = new URL(await unsubscribeUrl(env as any, maintainer.id, "owner_issues"));
    expect((await call(`/unsubscribe${url.search.replace(/t=[^&]+/, "t=wrong")}`, { method: "POST" })).status).toBe(400);
    const get = await call(`/unsubscribe${url.search}`);
    expect(get.status).toBe(302);
    expect((await call(`/unsubscribe${url.search}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(200);
    expect((await req(maintainer, "GET", "/me/email-prefs")).body.owner_issues).toBe("off");
  });

  it("tells authors what moderators decided, and roles when granted", async () => {
    const author = await person();
    const number = (await newIssue(author, { title: "Will be hidden by a moderator" })).body.number;
    const id = (await DB().prepare(`SELECT id FROM issues WHERE tool_id = ? AND number = ?`).bind(TOOL_ID, number).first<{ id: string }>())!.id;
    const staff = await person({ reviewer: true });
    await req(staff, "POST", `/moderation/issue/${id}`, { action: "hide", reason: "test" });
    expect((await inbox(author)).items[0]).toMatchObject({ kind: "moderation", summary: expect.stringContaining("hid your issue") });
    const admin = await person({ admin: true });
    await req(admin, "POST", "/admin/community/roles", { handle: author.handle, role: "triager", note: "thanks" });
    expect((await inbox(author)).items[0]).toMatchObject({ kind: "role", summary: expect.stringContaining("triager") });
  });
});

describe("failed runs reported from ot", () => {
  const report = (who: Who | null, body: Record<string, unknown>, ip = "203.0.113.9") =>
    call(`/tools/${TOOL}/run-reports`, { method: "POST", headers: { ...(who?.headers ?? {}), "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
  const base = { version: "1.2.0", exit_code: 1, os: "linux", arch: "arm64", engine: "podman", ot_version: "0.15.0" };

  it("joins the open broken issue for the version when signed in, or opens one", async () => {
    // A fresh version keeps this test apart from the other broken issues on the package.
    const vid = ulid();
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '7.7.7', 7, 7, 7, '{}', 'published', 1, 1)`).bind(vid, TOOL_ID).run();
    const a = await person();
    const first = await report(a, { ...base, version: "7.7.7" });
    expect(first.status).toBe(201);
    const opened = (await first.json()) as any;
    expect(opened).toMatchObject({ created: true, moderation: "visible" });
    const thread = await req(null, "GET", `/tools/${TOOL}/issues/${opened.issue}`);
    expect(thread.body.issue).toMatchObject({ kind: "broken", version: "7.7.7", platform: "linux/arm64", exit_code: 1, me_too: 1 });
    expect(thread.body.issue.title).toBe("7.7.7 exited with 1 on linux/arm64");
    const b = await person();
    expect((await (await report(b, { ...base, version: "7.7.7", exit_code: null, timed_out: true })).json()) as any).toEqual({ issue: opened.issue, created: false, moderation: "visible" });
    expect((await req(null, "GET", `/tools/${TOOL}/issues/${opened.issue}`)).body.issue.me_too).toBe(2);
  });

  it("only counts anonymous reports, once per address a day, and opens an unconfirmed issue after three", async () => {
    const vid = ulid();
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, '8.8.8', 8, 8, 8, '{}', 'published', 1, 1)`).bind(vid, TOOL_ID).run();
    const r = { ...base, version: "8.8.8" };
    expect((await (await report(null, r, "198.51.100.1")).json()) as any).toEqual({ counted: true });
    expect((await (await report(null, r, "198.51.100.1")).json()) as any).toEqual({ counted: false });
    await report(null, r, "198.51.100.2");
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ? AND dedupe_key = 'run_signals:8.8.8'`).bind(TOOL_ID).first()).toEqual({ n: 0 });
    await report(null, r, "198.51.100.3");
    const issue = await DB().prepare(`SELECT title, author_kind FROM issues WHERE tool_id = ? AND dedupe_key = 'run_signals:8.8.8'`).bind(TOOL_ID).first();
    expect(issue).toEqual({ title: "Several reports of 8.8.8 failing (unconfirmed)", author_kind: "system" });
  });

  it("takes only the fields it needs, and needs the feedback scope with a token", async () => {
    expect((await report(null, { ...base, os: "linux; rm -rf /" })).status).toBe(400);
    expect((await report(null, { ...base, exit_code: null })).status).toBe(400);
    expect((await report(null, { ...base, version: "0.0.0" })).status).toBe(404);
    expect(requiredScope("POST", `/v1/tools/${TOOL}/run-reports`)).toBe("feedback");
  });
});

describe("problems reported from the website without a sign-in", () => {
  const OTHER = "osintverse/email-header-parser";
  const OTHER_ID = "tool_osintverse_email-header-parser";
  const post = (path: string, body: Record<string, unknown>, ip: string, origin?: string) =>
    call(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  const problem = (body: Record<string, unknown>, ip: string, opts: { ref?: string; origin?: string } = {}) => post(`/tools/${opts.ref ?? TOOL}/problem-reports`, body, ip, opts.origin);
  const run = (version: string, ip: string, origin?: string) => post(`/tools/${TOOL}/run-reports`, { version, exit_code: 1, os: "linux", arch: "arm64" }, ip, origin);
  const json = async (res: Response) => (await res.json()) as any;
  const latest = async (toolId: string) => (await DB().prepare(`SELECT latest_version_id AS id FROM tools WHERE id = ?`).bind(toolId).first<{ id: string }>())!.id;
  /** A fresh version of the package, so each test's counts and issues are its own. */
  const fresh = async (v: string) => {
    const [major, minor, patch] = v.split(".").map(Number);
    await DB().prepare(`INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 'published', 1, 1)`)
      .bind(ulid(), TOOL_ID, v, major, minor, patch).run();
  };

  it("takes a kind and maybe a version, and counts the latest version when none is given", async () => {
    expect((await problem({ kind: "wrong_info" }, "192.0.2.1")).status).toBe(400);
    expect((await problem({}, "192.0.2.1")).status).toBe(400);
    expect((await problem({ kind: "broken", version: "1.2.0; drop" }, "192.0.2.1")).status).toBe(400);
    expect((await json(await problem({ kind: "broken", version: "0.0.0" }, "192.0.2.1"))).error.code).toBe("version_not_found");
    const res = await problem({ kind: "broken", platform: "linux/amd64" }, "192.0.2.1");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(res)).toEqual({ counted: true });
    expect((await DB().prepare(`SELECT kind, platform, count FROM problem_signals WHERE version_id = ?`).bind(await latest(TOOL_ID)).all()).results)
      .toEqual([{ kind: "broken", platform: "linux/amd64", count: 1 }]);
    expect(requiredScope("POST", `/v1/tools/${TOOL}/problem-reports`)).toBe("feedback");
  });

  it("counts each address once a day, with ot's failed runs, toward one unconfirmed issue", async () => {
    await fresh("6.1.0");
    expect(await json(await run("6.1.0", "192.0.2.11"))).toEqual({ counted: true });
    // The same address reporting on the website the same day isn't counted again.
    expect(await json(await problem({ kind: "broken", version: "6.1.0" }, "192.0.2.11"))).toEqual({ counted: false });
    expect(await json(await problem({ kind: "broken", version: "6.1.0", platform: "windows/amd64" }, "192.0.2.12"))).toEqual({ counted: true });
    expect(await json(await problem({ kind: "broken", version: "6.1.0", platform: "windows/amd64" }, "192.0.2.12"))).toEqual({ counted: false });
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ? AND dedupe_key = 'run_signals:6.1.0'`).bind(TOOL_ID).first()).toEqual({ n: 0 });
    // A platform the site never sends is dropped, so it can't put a link into the issue.
    await problem({ kind: "broken", version: "6.1.0", platform: "www.evil.example/x" }, "192.0.2.13");
    const issues = (await DB().prepare(`SELECT title, kind, author_kind, body_md FROM issues WHERE tool_id = ? AND dedupe_key = 'run_signals:6.1.0'`).bind(TOOL_ID).all<any>()).results;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "Several reports of 6.1.0 failing (unconfirmed)", kind: "broken", author_kind: "system" });
    expect(issues[0].body_md).toContain("from `ot run`: 1 (`linux/arm64`: 1)");
    expect(issues[0].body_md).toContain("from the website: 2 (");
    expect(issues[0].body_md).toContain("`windows/amd64`: 1");
    expect(issues[0].body_md).toContain("`unknown`: 1");
    expect(issues[0].body_md).not.toContain("evil");
  });

  it("counts outdated against the latest version, files it only when no other outdated issue is open, and closes it on the next version", async () => {
    await fileSystemIssue(env as any, OTHER_ID, "outdated", { title: "Upstream released 2.0.0", markdown: "Released 3 days ago.", version: "2.0.0" }, "outdated:report-test", "upstream_watch");
    for (const ip of ["192.0.2.21", "192.0.2.22", "192.0.2.23"]) {
      // Only the latest version can be out of date, so the version is ignored; the platform says nothing about it.
      expect(await json(await problem({ kind: "outdated", version: "0.0.1", platform: "linux/amd64" }, ip, { ref: OTHER }))).toEqual({ counted: true });
    }
    expect((await DB().prepare(`SELECT kind, platform, count FROM problem_signals WHERE version_id = ?`).bind(await latest(OTHER_ID)).all()).results)
      .toEqual([{ kind: "outdated", platform: "", count: 3 }]);
    // The upstream watcher's issue already says so.
    expect(await DB().prepare(`SELECT COUNT(*) AS n FROM issues WHERE tool_id = ? AND dedupe_key LIKE 'outdated\\_signals:%' ESCAPE '\\'`).bind(OTHER_ID).first()).toEqual({ n: 0 });
    await closeSystemIssue(env as any, OTHER_ID, "outdated:report-test", "fixed");
    await problem({ kind: "outdated" }, "192.0.2.24", { ref: OTHER });
    const issue = await DB().prepare(`SELECT id, title, kind, author_kind, status FROM issues WHERE tool_id = ? AND dedupe_key = 'outdated_signals:1.0.0'`).bind(OTHER_ID).first<any>();
    expect(issue).toMatchObject({ title: "Several reports say 1.0.0 is out of date (unconfirmed)", kind: "outdated", author_kind: "system", status: "open" });
    await announceVersion(env as any, OTHER_ID, "1.1.0");
    expect(await DB().prepare(`SELECT status FROM issues WHERE id = ?`).bind(issue.id).first()).toEqual({ status: "fixed" });
    expect(await DB().prepare(`SELECT body_md FROM issue_comments WHERE issue_id = ? AND author_kind = 'system'`).bind(issue.id).first())
      .toEqual({ body_md: expect.stringContaining("Version 1.1.0 is out") });
  });

  it("shares the daily limit per address with ot's failed runs", async () => {
    await fresh("6.2.0");
    for (let i = 0; i < 5; i++) expect((await run("6.2.0", "192.0.2.40")).status).toBe(201);
    for (let i = 0; i < 5; i++) expect((await problem({ kind: "broken", version: "6.2.0" }, "192.0.2.40")).status).toBe(201);
    const over = await problem({ kind: "broken", version: "6.2.0" }, "192.0.2.40");
    expect(over.status).toBe(429);
    expect((await json(over)).error).toMatchObject({ code: "too_many_posts", hint: "sign in to describe it in an issue" });
  });

  it("refuses reports another website sends from its visitors' browsers", async () => {
    await fresh("6.3.0");
    const foreign = await problem({ kind: "broken", version: "6.3.0" }, "192.0.2.50", { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await json(foreign)).error.code).toBe("foreign_origin");
    expect((await run("6.3.0", "192.0.2.50", "https://evil.example")).status).toBe(403);
    expect((await problem({ kind: "broken", version: "6.3.0" }, "192.0.2.50", { origin: (env as any).SITE_URL })).status).toBe(201);
  });
});

describe("community events in the activity feed", () => {
  it("lists confirmed and fixed issues worded from fields, and only when asked for", async () => {
    const p = await person();
    const title = `Fails with a secret word ${uniq()}`;
    const { body } = await newIssue(p, { title });
    const staff = await person({ reviewer: true });
    await req(staff, "POST", `/tools/${TOOL}/issues/${body.number}/status`, { status: "confirmed" });
    await req(staff, "POST", `/tools/${TOOL}/issues/${body.number}/status`, { status: "fixed", fixed_in: "1.2.1" });

    const plain = (await req(null, "GET", "/activity?limit=100")).body;
    expect(plain.events.some((e: any) => String(e.type).startsWith("issue_"))).toBe(false);
    const community = (await req(null, "GET", "/activity?events=community&limit=100")).body;
    const mine = community.events.filter((e: any) => e.number === body.number && e.ref === TOOL);
    expect(mine.map((e: any) => e.type)).toEqual(["issue_fixed", "issue_confirmed"]);
    expect(mine[0]).toMatchObject({ kind: "tool", issue_kind: "broken" });
    expect(JSON.stringify(community)).not.toContain(title);
    expect((await req(null, "GET", "/activity?events=everything")).res.status).toBe(400);
    // Publisher filters still apply to community events.
    expect((await req(null, "GET", "/activity?events=all&namespace=osintverse&limit=100")).body.events.some((e: any) => e.number === body.number && e.ref === TOOL)).toBe(false);
  });
});

describe("following a package's releases", () => {
  // Its own package, so other tests' idea of holehe-lite's latest version doesn't move.
  const WHOIS = "dheeraj/whois-lite";
  const WHOIS_ID = "tool_dheeraj_whois-lite";

  /** Publishes another version of whois-lite the way a passing scan would. */
  async function release(version: string) {
    const { publishVersion } = await import("../src/scans");
    const { testEnv } = await import("./helpers");
    const latest = await DB().prepare(`SELECT v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id WHERE t.id = ?`).bind(WHOIS_ID).first<{ manifest_json: string }>();
    const m = { ...JSON.parse(latest!.manifest_json), version };
    const [core, pre] = version.split("-");
    const [major, minor, patch] = core!.split(".").map(Number);
    const id = ulid();
    await DB().prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'docker', 'awaiting_review', ?)`,
    ).bind(id, WHOIS_ID, version, major, minor, patch, pre ?? "", JSON.stringify(m), Date.now()).run();
    await publishVersion(await testEnv(), id);
    return id;
  }
  const items = async (who: Who) =>
    (await DB().prepare(`SELECT kind, scope, summary, path FROM inbox WHERE user_id = ? AND tool_id = ? ORDER BY created_at`).bind(who.id, WHOIS_ID).all<any>()).results;

  it("follows and unfollows, and lists what you follow", async () => {
    expect((await req(null, "PUT", `/tools/${WHOIS}/follow`)).res.status).toBe(401);
    const alice = await person();
    expect((await req(alice, "GET", `/tools/${WHOIS}/follow`)).body).toEqual({ following: false, level: null, followed_at: null });
    expect((await req(alice, "PUT", `/tools/${WHOIS}/follow`)).body).toEqual({ following: true, level: "all" });
    expect((await req(alice, "PUT", `/tools/${WHOIS}/follow`)).body).toEqual({ following: true, level: "all" });
    const state = await req(alice, "GET", `/tools/${WHOIS}/follow`);
    expect(state.body.following).toBe(true);
    expect(state.res.headers.get("cache-control")).toBe("private, no-store");
    const mine = (await req(alice, "GET", "/me/follows")).body;
    expect(mine.follows).toEqual([expect.objectContaining({ ref: WHOIS, kind: "tool", level: "all", followed_at: state.body.followed_at })]);
    expect((await req(alice, "DELETE", `/tools/${WHOIS}/follow`)).body).toEqual({ following: false });
    expect((await req(alice, "GET", "/me/follows")).body.follows).toEqual([]);
    expect((await req(alice, "PUT", "/tools/dheeraj/no-such-tool/follow")).res.status).toBe(404);
  });

  it("takes the feedback scope to follow and read to look", async () => {
    expect(requiredScope("PUT", `/v1/tools/${WHOIS}/follow`)).toBe("feedback");
    expect(requiredScope("DELETE", `/v1/tools/${WHOIS}/follow`)).toBe("feedback");
    expect(requiredScope("GET", `/v1/tools/${WHOIS}/follow`)).toBe("read");
    const reader = await person({ scopes: "read" });
    expect((await req(reader, "PUT", `/tools/${WHOIS}/follow`)).body.error.code).toBe("insufficient_scope");
    expect((await req(reader, "GET", `/tools/${WHOIS}/follow`)).res.status).toBe(200);
  });

  it("tells followers once when a version becomes the latest, and the people following its issues on the issue", async () => {
    const follower = await person();
    await req(follower, "PUT", `/tools/${WHOIS}/follow`);
    // An issue's author follows it; another person follows the issue and the package; one muted the issue.
    const author = await person();
    const issue = (await req(author, "POST", `/tools/${WHOIS}/issues`, { kind: "broken", title: "Times out on every domain", body: "Every lookup times out after five minutes.", version: "2.0.0" })).body;
    const both = await person();
    await req(both, "PUT", `/tools/${WHOIS}/follow`);
    await req(both, "PUT", `/tools/${WHOIS}/issues/${issue.number}/subscription`);
    const muted = await person();
    await req(muted, "PUT", `/tools/${WHOIS}/follow`);
    await req(muted, "PUT", `/tools/${WHOIS}/issues/${issue.number}/subscription`);
    await req(muted, "DELETE", `/tools/${WHOIS}/issues/${issue.number}/subscription`);

    const id = await release("2.1.0");
    const out = { kind: "release", scope: "releases", summary: `${WHOIS} 2.1.0 is out`, path: `/${WHOIS}/versions#v2.1.0` };
    expect(await items(follower)).toEqual([out]);
    expect(await items(muted)).toEqual([out]);
    const onIssue = { kind: "comment", scope: "community", summary: `${WHOIS} 2.1.0 is out: does it fix #${issue.number}? Times out on every domain`, path: `/${WHOIS}/issues/${issue.number}` };
    expect(await items(both)).toEqual([onIssue]);
    expect((await items(author)).filter((i) => i.kind !== "issue_opened")).toEqual([onIssue]);
    const thread = await req(null, "GET", `/tools/${WHOIS}/issues/${issue.number}`);
    expect(thread.body.comments.filter((c: any) => c.body_html.includes("Version 2.1.0 is out"))).toHaveLength(1);

    // Published again (a retried message): nothing new.
    const { publishVersion } = await import("../src/scans");
    const { testEnv } = await import("./helpers");
    await publishVersion(await testEnv(), id);
    expect(await items(follower)).toHaveLength(1);

    // An older patch, and a prerelease behind the stable latest, aren't announced.
    await release("2.0.1");
    await release("3.0.0-rc1");
    expect(await items(follower)).toHaveLength(1);
    const again = await req(null, "GET", `/tools/${WHOIS}/issues/${issue.number}`);
    expect(again.body.comments.filter((c: any) => c.body_html.includes("is out"))).toHaveLength(1);
  });

  it("has its own email preference and unsubscribe link", async () => {
    const { unsubscribeUrl } = await import("../src/inbox");
    const who = await person();
    const fresh = { community: "immediate", owner_issues: "immediate", releases: "immediate", lifecycle: "immediate", security: "immediate" };
    expect((await req(who, "GET", "/me/email-prefs")).body).toEqual(fresh);
    expect((await req(who, "PUT", "/me/email-prefs", { releases: "daily" })).body).toEqual({ ...fresh, releases: "daily" });
    expect((await req(who, "PUT", "/me/email-prefs", { releases: "weekly" })).res.status).toBe(400);
    const url = new URL(await unsubscribeUrl(env as any, who.id, "releases"));
    expect((await call(`/unsubscribe${url.search}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(200);
    expect((await req(who, "GET", "/me/email-prefs")).body.releases).toBe("off");
  });
});

describe("following publishers and input types", () => {
  /** A new dheeraj package taking a domain, published for the first time, then once more. */
  async function newPackage(name: string, versions: string[]) {
    const { publishVersion } = await import("../src/scans");
    const { testEnv } = await import("./helpers");
    const toolId = `tool_dheeraj_${name}`;
    await DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, 'ns_dheeraj', 'tool', ?, 'Follow test tool', 1, 1)`).bind(toolId, name).run();
    const base = await DB().prepare(`SELECT v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id WHERE t.id = 'tool_dheeraj_whois-lite'`).first<{ manifest_json: string }>();
    for (const version of versions) {
      const [major, minor, patch] = version.split(".").map(Number);
      const id = ulid();
      await DB().prepare(
        `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, 'docker', 'awaiting_review', ?)`,
      ).bind(id, toolId, version, major, minor, patch, JSON.stringify({ ...JSON.parse(base!.manifest_json), name, version }), Date.now()).run();
      await publishVersion(await testEnv(), id);
    }
    return toolId;
  }
  const items = async (who: Who, toolId: string) =>
    (await DB().prepare(`SELECT kind, scope, summary, path FROM inbox WHERE user_id = ? AND tool_id = ? ORDER BY created_at, summary`).bind(who.id, toolId).all<any>()).results;

  it("follows and unfollows publishers and input types, and lists them", async () => {
    const who = await person();
    expect((await req(null, "PUT", "/me/follows/publisher/dheeraj")).res.status).toBe(401);
    expect((await req(who, "GET", "/me/follows/publisher/dheeraj")).body).toEqual({ following: false, followed_at: null });
    expect((await req(who, "PUT", "/me/follows/publisher/dheeraj")).body).toEqual({ following: true });
    expect((await req(who, "PUT", "/me/follows/input/domain")).body).toEqual({ following: true });
    const state = await req(who, "GET", "/me/follows/input/domain");
    expect(state.body.following).toBe(true);
    expect(state.res.headers.get("cache-control")).toBe("private, no-store");
    const mine = (await req(who, "GET", "/me/follows")).body;
    expect(mine.publishers).toEqual([expect.objectContaining({ name: "dheeraj" })]);
    expect(mine.inputs).toEqual([{ type: "domain", followed_at: state.body.followed_at }]);
    expect((await req(who, "DELETE", "/me/follows/publisher/dheeraj")).body).toEqual({ following: false });
    expect((await req(who, "GET", "/me/follows")).body.publishers).toEqual([]);

    expect((await req(who, "PUT", "/me/follows/input/string")).body.error.code).toBe("input_type_not_found");
    expect((await req(who, "PUT", "/me/follows/input/planet")).body.error.code).toBe("input_type_not_found");
    expect((await req(who, "PUT", "/me/follows/publisher/no-such-publisher")).body.error.code).toBe("namespace_not_found");
    // A namespace still waiting for review can't be followed.
    expect((await req(who, "PUT", "/me/follows/publisher/newbie")).body.error.code).toBe("namespace_not_found");
    expect((await req(who, "PUT", "/me/follows/planet/earth")).res.status).toBe(404);
  });

  it("stops at 200 follows", async () => {
    const who = await person();
    await DB().batch(Array.from({ length: 199 }, (_, i) =>
      DB().prepare(`INSERT INTO follows (user_id, kind, target, created_at) VALUES (?, 'publisher', ?, 1)`).bind(who.id, `filler-${i}`)));
    expect((await req(who, "PUT", "/me/follows/publisher/dheeraj")).body).toEqual({ following: true });
    const res = await req(who, "PUT", "/me/follows/input/email");
    expect(res.res.status).toBe(429);
    expect(res.body.error.code).toBe("too_many_follows");
    // Following again what you already follow still answers.
    expect((await req(who, "PUT", "/me/follows/publisher/dheeraj")).body).toEqual({ following: true });
  });

  it("takes the feedback scope to follow and read to look", async () => {
    expect(requiredScope("PUT", "/v1/me/follows/publisher/dheeraj")).toBe("feedback");
    expect(requiredScope("DELETE", "/v1/me/follows/input/domain")).toBe("feedback");
    expect(requiredScope("GET", "/v1/me/follows/input/domain")).toBe("read");
    const reader = await person({ scopes: "read" });
    expect((await req(reader, "PUT", "/me/follows/input/domain")).body.error.code).toBe("insufficient_scope");
  });

  it("tells publisher followers of every release and input followers of new packages only, once each", async () => {
    const pub = await person();
    await req(pub, "PUT", "/me/follows/publisher/dheeraj");
    const input = await person();
    await req(input, "PUT", "/me/follows/input/domain");
    const other = await person();
    await req(other, "PUT", "/me/follows/input/email");
    const all = await person();
    await req(all, "PUT", "/me/follows/publisher/dheeraj");
    await req(all, "PUT", "/me/follows/input/domain");

    const toolId = await newPackage("follow-me", ["1.0.0", "1.1.0"]);
    const ref = "dheeraj/follow-me";
    const fresh = { kind: "release", scope: "releases", summary: `dheeraj published a new tool: ${ref}`, path: `/${ref}` };
    const next = { kind: "release", scope: "releases", summary: `${ref} 1.1.0 is out`, path: `/${ref}/versions#v1.1.0` };
    expect(await items(pub, toolId)).toEqual([fresh, next]);
    expect(await items(input, toolId)).toEqual([{ ...fresh, summary: `New tool for domain: ${ref}` }]);
    expect(await items(other, toolId)).toEqual([]);
    // The closest follow words the item, and nobody gets two for one release.
    expect(await items(all, toolId)).toEqual([fresh, next]);
  });
});

describe("follow levels, lifecycle changes and security warnings", () => {
  /** A new dheeraj package, published version by version (`warn` ones as if their scan had warned). */
  async function newPackage(versions: string[], warn: string[] = []) {
    const { publishVersion } = await import("../src/scans");
    const { testEnv } = await import("./helpers");
    const name = `life-${uniq()}`;
    const toolId = `tool_dheeraj_${name}`;
    await DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, 'ns_dheeraj', 'tool', ?, 'Lifecycle test tool', 1, 1)`).bind(toolId, name).run();
    const publish = async (version: string) => {
      const base = await DB().prepare(`SELECT v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id WHERE t.id = 'tool_dheeraj_whois-lite'`).first<{ manifest_json: string }>();
      const [major, minor, patch] = version.split(".").map(Number);
      const id = ulid();
      await DB().prepare(
        `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, status, scan_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, 'docker', 'awaiting_review', ?, ?)`,
      ).bind(id, toolId, version, major, minor, patch, JSON.stringify({ ...JSON.parse(base!.manifest_json), name, version }), warn.includes(version) ? "warn" : "pass", Date.now()).run();
      await publishVersion(await testEnv(), id);
    };
    for (const v of versions) await publish(v);
    return { name, ref: `dheeraj/${name}`, toolId, publish };
  }
  const items = async (who: Who, toolId: string) =>
    (await DB().prepare(`SELECT kind, scope, summary, path FROM inbox WHERE user_id = ? AND tool_id = ? ORDER BY created_at, summary`).bind(who.id, toolId).all<any>()).results;
  const followAt = async (ref: string, level?: string) => {
    const who = await person();
    await req(who, "PUT", `/tools/${ref}/follow`, level ? { level } : undefined);
    return who;
  };

  it("follows at a level, keeps it when following again, and lists it", async () => {
    const who = await person();
    const ref = "dheeraj/whois-lite";
    expect((await req(who, "PUT", `/tools/${ref}/follow`, { level: "releases" })).body).toEqual({ following: true, level: "releases" });
    expect((await req(who, "PUT", `/tools/${ref}/follow`)).body).toEqual({ following: true, level: "releases" });
    expect((await req(who, "PUT", `/tools/${ref}/follow`, {})).body.level).toBe("releases");
    expect((await req(who, "PUT", `/tools/${ref}/follow`, { level: "weekly" })).body.error.code).toBe("invalid_body");
    expect((await req(who, "PUT", `/tools/${ref}/follow`, { level: "muted" })).body.level).toBe("muted");
    expect((await req(who, "GET", `/tools/${ref}/follow`)).body).toMatchObject({ following: true, level: "muted" });
    expect((await req(who, "GET", "/me/follows")).body.follows).toEqual([expect.objectContaining({ ref, level: "muted" })]);
  });

  it("tells followers about yanks, deprecations, takedowns and moves, as their level says, never the person who acted", async () => {
    const pkg = await newPackage(["1.0.0", "1.1.0", "1.2.0"]);
    const all = await followAt(pkg.ref);
    const rel = await followAt(pkg.ref, "releases");
    const muted = await followAt(pkg.ref, "muted");
    const owner = await person({ member: "ns_dheeraj" });
    await req(owner, "PUT", `/tools/${pkg.ref}/follow`);
    const life = (summary: string, path = `/${pkg.ref}`) => ({ kind: "lifecycle", scope: "lifecycle", summary, path });

    expect((await req(owner, "POST", `/tools/${pkg.ref}/1.2.0/yank`)).res.status).toBe(200);
    await req(owner, "POST", `/tools/${pkg.ref}/1.2.0/unyank`);
    expect(await items(all, pkg.toolId)).toEqual(expect.arrayContaining([
      life(`${pkg.ref} 1.2.0 was yanked: @latest no longer installs it`, `/${pkg.ref}/versions`),
      life(`${pkg.ref} 1.2.0 is available again`, `/${pkg.ref}/versions`),
    ]));
    expect(await items(all, pkg.toolId)).toHaveLength(2);

    await req(owner, "POST", `/tools/${pkg.ref}/deprecate`, { message: "Use whois-lite.", replacement: "dheeraj/whois-lite" });
    // A new message on a package that is already deprecated tells nobody again.
    await req(owner, "POST", `/tools/${pkg.ref}/deprecate`, { message: "Really, use whois-lite." });
    await req(owner, "DELETE", `/tools/${pkg.ref}/deprecate`);
    await req(owner, "DELETE", `/tools/${pkg.ref}/deprecate`);
    expect(await items(all, pkg.toolId)).toEqual(expect.arrayContaining([
      life(`${pkg.ref} is deprecated; use dheeraj/whois-lite instead: Use whois-lite.`),
      life(`${pkg.ref} is no longer deprecated`),
    ]));
    expect(await items(all, pkg.toolId)).toHaveLength(4);

    const reviewer = await person({ reviewer: true });
    expect((await req(reviewer, "POST", `/admin/tools/${pkg.ref}/1.0.0/remove`, { category: "license", reason: "The upstream licence forbids redistribution." })).res.status).toBe(200);
    expect((await req(reviewer, "POST", `/admin/tools/${pkg.ref}/1.1.0/remove`, { category: "malware", reason: "Sends keys to a third party." })).res.status).toBe(200);
    const taken = life(`${pkg.ref} 1.0.0 was taken down over its license`);
    const malware = { kind: "security", scope: "security", summary: `${pkg.ref} 1.1.0 was taken down as malware; uninstall it with \`ot uninstall ${pkg.ref}\``, path: `/${pkg.ref}` };
    expect(await items(all, pkg.toolId)).toEqual(expect.arrayContaining([taken, malware]));
    expect(await items(all, pkg.toolId)).toHaveLength(6);
    // The reviewer's reason is never in a notification.
    expect(JSON.stringify(await items(all, pkg.toolId))).not.toContain("third party");
    // Following releases only: new versions and security warnings.
    expect(await items(rel, pkg.toolId)).toEqual([malware]);
    expect(await items(muted, pkg.toolId)).toEqual([]);
    // The owner acted every time, so heard nothing, except the takedowns a reviewer did.
    expect(await items(owner, pkg.toolId)).toEqual(expect.arrayContaining([taken, malware]));
    expect(await items(owner, pkg.toolId)).toHaveLength(2);

    const { completeTransfer } = await import("../src/transfers");
    await completeTransfer(env as any, owner.id, {
      id: ulid(), tool_id: pkg.toolId, from_namespace_id: "ns_dheeraj", to_namespace_id: "ns_osintverse", requested_by: owner.id, kind: "transfer", status: "accepted",
    } as any);
    expect(await items(all, pkg.toolId)).toContainEqual(life(`${pkg.ref} moved to osintverse/${pkg.name}; \`ot update\` follows it there`, `/osintverse/${pkg.name}`));
    // Follows go with the package.
    expect((await req(all, "GET", "/me/follows")).body.follows[0].ref).toBe(`osintverse/${pkg.name}`);
  });

  it("tells followers when archiving the repository deprecates the package, and when that is undone", async () => {
    const { applyMeta } = await import("../src/sync");
    const pkg = await newPackage(["1.0.0"]);
    const all = await followAt(pkg.ref);
    const source = { id: ulid(), tool_id: pkg.toolId, namespace_id: "ns_dheeraj", provider: "github", project_id: "77", path: `dheeraj/${pkg.name}`, url: "", sync_status: "ok", archived: 0, unavailable_since: null } as any;
    const meta = { path: `dheeraj/${pkg.name}`, defaultBranch: "main", description: null, topics: [], stars: 0, archived: true, visibility: "public" } as any;
    expect(await applyMeta(env as any, source, meta)).toBe("archived");
    expect((await items(all, pkg.toolId)).map((i) => i.summary)).toEqual([`${pkg.ref} is deprecated: its source repository was archived`]);
    expect(await applyMeta(env as any, { ...source, archived: 1 }, { ...meta, archived: false })).toBe("unarchived");
    expect((await items(all, pkg.toolId)).map((i) => i.summary)).toContain(`${pkg.ref} is no longer deprecated: its source repository was unarchived`);
  });

  it("warns followers of a release with security warnings, and muting leaves out what a followed publisher would bring", async () => {
    const pkg = await newPackage(["1.0.0"], ["1.1.0"]);
    const all = await followAt(pkg.ref);
    const rel = await followAt(pkg.ref, "releases");
    const muted = await followAt(pkg.ref, "muted");
    await req(muted, "PUT", "/me/follows/publisher/dheeraj");
    await pkg.publish("1.1.0");
    const out = { kind: "release", scope: "releases", summary: `${pkg.ref} 1.1.0 is out`, path: `/${pkg.ref}/versions#v1.1.0` };
    const warning = {
      kind: "security", scope: "security", path: `/${pkg.ref}/security`,
      summary: `${pkg.ref} 1.1.0 was published with security warnings: its scan found fixable critical or high vulnerabilities`,
    };
    expect(await items(all, pkg.toolId)).toEqual(expect.arrayContaining([out, warning]));
    expect(await items(all, pkg.toolId)).toHaveLength(2);
    expect(await items(rel, pkg.toolId)).toHaveLength(2);
    expect(await items(muted, pkg.toolId)).toEqual([]);
  });
});

describe("notification settings", () => {
  /** A person with two sign-in accounts that have email addresses. */
  async function withAccounts() {
    const p = await person();
    await DB().batch([
      DB().prepare(`UPDATE users SET email = ? WHERE id = ?`).bind(`${p.handle}@github.example`, p.id),
      DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, email, created_at) VALUES (?, ?, 'github', ?, ?, ?, 1)`).bind(ulid(), p.id, `gh${uniq()}`, p.handle, `${p.handle}@github.example`),
      DB().prepare(`INSERT INTO accounts (id, user_id, provider, provider_user_id, login, email, created_at) VALUES (?, ?, 'gitlab', ?, ?, ?, 1)`).bind(ulid(), p.id, `gl${uniq()}`, p.handle, `${p.handle}@gitlab.example`),
    ]);
    return p;
  }
  const item = (who: Who, scope: string, summary: string, at = Date.now()) =>
    DB().prepare(`INSERT INTO inbox (id, user_id, kind, scope, summary, path, created_at) VALUES (?, ?, ?, ?, ?, '/x', ?)`).bind(ulid(), who.id, scope === "releases" ? "release" : scope, scope, summary, at).run();

  it("starts from every kind in the inbox and emailed at once, to the first address known", async () => {
    const p = await withAccounts();
    const s = (await req(p, "GET", "/me/notification-settings")).body;
    for (const k of ["community", "owner_issues", "releases", "lifecycle", "security"]) expect(s.scopes[k]).toEqual({ inbox: true, email: "immediate" });
    expect(s.email).toEqual({
      to: null, address: `${p.handle}@github.example`,
      options: [{ provider: "github", address: `${p.handle}@github.example` }, { provider: "gitlab", address: `${p.handle}@gitlab.example` }],
    });
    expect(requiredScope("PUT", "/v1/me/notification-settings")).toBe("manage");
    expect((await req(null, "GET", "/me/notification-settings")).res.status).toBe(401);
  });

  it("keeps a kind out of the inbox and its unread count, and brings it back", async () => {
    const p = await withAccounts();
    await item(p, "lifecycle", "Something was yanked", Date.now() - 1000);
    await item(p, "releases", "Something is out");
    expect((await req(p, "GET", "/me")).body.unread).toBe(2);
    const off = await req(p, "PUT", "/me/notification-settings", { scopes: { lifecycle: { inbox: false, email: "daily" } } });
    expect(off.body.scopes.lifecycle).toEqual({ inbox: false, email: "daily" });
    expect(off.body.scopes.releases).toEqual({ inbox: true, email: "immediate" });
    const inbox = (await req(p, "GET", "/me/inbox")).body;
    expect(inbox.items.map((i: any) => i.summary)).toEqual(["Something is out"]);
    expect(inbox.items[0].scope).toBe("releases");
    expect(inbox.unread).toBe(1);
    expect((await req(p, "GET", "/me")).body.unread).toBe(1);
    // The older form keeps the inbox switch, and the newer one keeps what it set.
    await req(p, "PUT", "/me/email-prefs", { community: "off" });
    expect((await req(p, "GET", "/me/notification-settings")).body.scopes).toMatchObject({ lifecycle: { inbox: false, email: "daily" }, community: { inbox: true, email: "off" } });
    expect((await req(p, "GET", "/me/email-prefs")).body).toMatchObject({ lifecycle: "daily", community: "off" });
    await req(p, "PUT", "/me/notification-settings", { scopes: { lifecycle: { inbox: true } } });
    expect((await req(p, "GET", "/me/inbox")).body.items).toHaveLength(2);

    // Only what is unread.
    await req(p, "POST", "/me/inbox/read", { ids: [inbox.items[0].id] });
    expect((await req(p, "GET", "/me/inbox?unread=1")).body.items.map((i: any) => i.summary)).toEqual(["Something was yanked"]);
  });

  it("refuses settings it doesn't know", async () => {
    const p = await withAccounts();
    for (const body of [{ scopes: { weekly: {} } }, { scopes: { releases: { email: "weekly" } } }, { scopes: { releases: { inbox: "no" } } }, { scopes: [] }, { email_to: "osintverse" }, { email_to: 3 }]) {
      expect((await req(p, "PUT", "/me/notification-settings", body)).body.error.code).toBe("invalid_body");
    }
  });

  it("sends email to the address the person chose, and unsubscribes from the new kinds", async () => {
    const { deliverInbox, unsubscribeUrl } = await import("../src/inbox");
    const { fakeHosts } = await import("./helpers");
    const calls = fakeHosts({ "POST https://api.resend.com/emails": { id: "email" } });
    const p = await withAccounts();
    const chosen = await req(p, "PUT", "/me/notification-settings", { email_to: "gitlab" });
    expect(chosen.body.email).toMatchObject({ to: "gitlab", address: `${p.handle}@gitlab.example` });
    await item(p, "security", "A security warning for you", Date.now() - 5 * 60_000);
    await deliverInbox(env as any, "immediate");
    const mails = calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body)).filter((m) => m.text.includes("A security warning for you"));
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([`${p.handle}@gitlab.example`]);
    expect(mails[0].text).toContain("/settings/notifications");
    // Back to the first address known.
    expect((await req(p, "PUT", "/me/notification-settings", { email_to: null })).body.email).toMatchObject({ to: null, address: `${p.handle}@github.example` });

    const url = new URL(await unsubscribeUrl(env as any, p.id, "security"));
    expect((await call(`/unsubscribe${url.search}`, { method: "POST" })).status).toBe(200);
    expect((await req(p, "GET", "/me/notification-settings")).body.scopes.security.email).toBe("off");
  });
});
