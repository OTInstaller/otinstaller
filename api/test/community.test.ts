// Community: issues and comments on packages, holds and screening, triage roles, locks and edits, confirmations,
// flags and moderation, counters, rate limits, system issues and token scopes.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { announceVersion, closeSystemIssue, fileSystemIssue, REDACTED, renderPost, screen } from "../src/community";
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
    expect(renderPost("see [docs](https://example.com/docs)")).toContain('rel="nofollow ugc noopener" href="https://example.com/docs"');
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
