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

describe("community status", () => {
  it("puts the health check, confirmations and open issues in one line, without error excerpts", async () => {
    const p = await person();
    await req(p, "PUT", `/tools/${TOOL}/confirmations`, { result: "works", platform: "linux/amd64" });
    const v = (await DB().prepare(`SELECT latest_version_id FROM tools WHERE id = ?`).bind(TOOL_ID).first<{ latest_version_id: string }>())!;
    await DB().prepare(`INSERT INTO health_checks (id, tool_id, version_id, result, duration_ms, error_excerpt, failure_class, ran_at) VALUES (?, ?, ?, 'fail', 900, 'secret output about a target', 'timeout', ?)`)
      .bind(ulid(), TOOL_ID, v.latest_version_id, Date.now() - 1000).run();
    const s = await req(null, "GET", `/tools/${TOOL}/status`);
    expect(s.res.headers.get("cache-control")).toMatch(/public.*max-age=300/);
    expect(s.body.line.text).toMatch(/works for \d+ (person|people)[^(]*\([^)]*linux\/amd64/);
    expect(s.body.health.history[0]).toMatchObject({ result: "fail", failure: "timeout" });
    expect(JSON.stringify(s.body)).not.toContain("secret output");
    const detail = await req(null, "GET", `/tools/${TOOL}`);
    expect(detail.body.community).toEqual({ open_broken: expect.any(Number), open_outdated: expect.any(Number) });
  });

  it("says failing, mixed, working or unknown from the facts", async () => {
    const { statusLine } = await import("../src/community");
    const now = Date.now();
    const base = { health: "healthy", checked_at: now - 3600_000, works: 0, broken: 0, platforms: [], open_broken: 0, version: "1.0.0" };
    expect(statusLine(base, now)).toEqual({ state: "working", text: "Passed the registry's health check today." });
    expect(statusLine({ ...base, health: "broken" }, now).state).toBe("failing");
    expect(statusLine({ ...base, broken: 3, works: 1 }, now).state).toBe("failing");
    expect(statusLine({ ...base, open_broken: 1 }, now)).toMatchObject({ state: "mixed", text: expect.stringContaining("1 open broken issue") });
    expect(statusLine({ ...base, health: "unknown", checked_at: null }, now)).toEqual({ state: "unknown", text: "Not health-checked yet." });
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
    expect((await req(quiet, "PUT", "/me/email-prefs", { owner_issues: "off" })).body).toEqual({ community: "immediate", owner_issues: "off" });
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
