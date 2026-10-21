import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { call, fakeHosts, testEnv } from "./helpers";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;
let sev1Search: () => Response | object = () => ({ total_count: 0 });

beforeEach(() => {
  sev1Search = () => ({ total_count: 0 });
  fakeHosts({ "GET https://api.github.com/search/issues": () => sev1Search() });
});

async function person(flags: { reviewer?: boolean } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, is_reviewer, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(id, login, `${login}@example.com`, flags.reviewer ? 1 : 0, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

/** A namespace on the given host with one published tool. */
async function publisher(provider: "github" | "gitlab", name = `ns${uniq()}`) {
  const nsId = ulid();
  const toolId = ulid();
  const versionId = ulid();
  const now = Date.now();
  await DB().batch([
    DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, ?, ?, ?, 'user', 'active', ?)`)
      .bind(nsId, provider, uniq(), name, now),
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, ?, 'tool', ?, 'x', ?, ?)`)
      .bind(toolId, nsId, `tool${uniq()}`, now, now),
    DB().prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, status, published_at, created_at)
       VALUES (?, ?, '1.0.0', 1, 0, 0, '{}', 'docker', 'published', ?, ?)`,
    ).bind(versionId, toolId, now, now),
    DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(versionId, toolId),
  ]);
  return { name, toolId };
}

const post = (path: string, headers: Record<string, string>, body: unknown = {}) => call(path, { method: "POST", headers, body: JSON.stringify(body) });
const metrics = async (auth: Record<string, string>) => (await (await call("/admin/beta-metrics", { headers: auth })).json()) as any;

// ---------- feedback ----------

describe("feedback", () => {
  it("takes feedback from anyone and links it to a signed-in sender", async () => {
    const anon = await post("/feedback", { "content-type": "application/json", "cf-connecting-ip": `10.0.0.${n % 250}` }, {
      kind: "idea", message: "Could search remember my filters?", email: "pat@example.com", page: "/search",
    });
    expect(anon.status).toBe(201);
    const me = await person();
    const cli = await post("/feedback", me.auth, { kind: "bug", message: "ot install hangs on Windows", source: "cli", client: "ot 0.9.0 (windows/amd64)", page: "ot install" });
    expect(cli.status).toBe(201);
    const { id } = (await cli.json()) as any;

    const reviewer = await person({ reviewer: true });
    expect((await call("/admin/feedback", { headers: me.auth })).status).toBe(403);
    const list = (await (await call("/admin/feedback", { headers: reviewer.auth })).json()) as any;
    const mine = list.feedback.find((f: any) => f.id === id);
    expect(mine).toMatchObject({ kind: "bug", source: "cli", client: "ot 0.9.0 (windows/amd64)", sender: me.login, status: "open" });
    // Bugs come first in the queue.
    expect(list.feedback[0].kind).toBe("bug");

    expect(await (await post(`/admin/feedback/${id}/resolve`, reviewer.auth, { status: "done", note: "fixed in 0.9.1" })).json()).toEqual({ id, status: "done" });
    const done = (await (await call("/admin/feedback?status=done", { headers: reviewer.auth })).json()) as any;
    expect(done.feedback.find((f: any) => f.id === id)).toMatchObject({ status: "done", note: "fixed in 0.9.1", resolved_by: reviewer.login });
    expect((await post(`/admin/feedback/${id}/resolve`, reviewer.auth, { status: "maybe" })).status).toBe(400);
  });

  it("rejects empty messages, unknown kinds and bad addresses, and limits senders", async () => {
    const h = { "content-type": "application/json", "cf-connecting-ip": `192.0.2.${n % 250}` };
    expect((await post("/feedback", h, { message: "" })).status).toBe(400);
    expect((await post("/feedback", h, { kind: "rant", message: "hello there" })).status).toBe(400);
    expect((await post("/feedback", h, { message: "hello there", email: "not-an-address" })).status).toBe(400);
    const me = await person();
    for (let i = 0; i < 10; i++) expect((await post("/feedback", me.auth, { message: `note ${i}` })).status).toBe(201);
    expect((await post("/feedback", me.auth, { message: "one too many" })).status).toBe(429);
  });
});

// ---------- beta metrics ----------

describe("beta metrics", () => {
  it("counts external publishers by host, failed publishes and open sev-1 issues", async () => {
    const reviewer = await person({ reviewer: true });
    expect((await call("/admin/beta-metrics", { headers: (await person()).auth })).status).toBe(403);
    const before = await metrics(reviewer.auth);

    const gl = await publisher("gitlab");
    await publisher("github");
    // First-party namespaces don't count as external authors.
    if (!(await DB().prepare(`SELECT 1 FROM namespaces WHERE name = 'osintverse'`).first())) await publisher("github", "osintverse");
    await DB().prepare(`INSERT INTO publish_jobs (id, delivery_id, provider, repo, tag, status, error_code, created_at, updated_at) VALUES (?, ?, 'gitlab', 'a/b', 'v1', 'rejected', 'manifest_schema', ?, ?)`)
      .bind(ulid(), ulid(), Date.now(), Date.now()).run();
    await DB().prepare(`INSERT INTO install_counts (tool_id, version_id, day, count) SELECT ?, latest_version_id, date('now'), 5 FROM tools WHERE id = ?`).bind(gl.toolId, gl.toolId).run();
    sev1Search = () => ({ total_count: 2 });

    const after = await metrics(reviewer.auth);
    expect(after.publishers.by_host.gitlab.publishers).toBe(before.publishers.by_host.gitlab.publishers + 1);
    expect(after.publishers.by_host.gitlab.names).toContain(gl.name);
    expect(after.publishers.external).toBe(before.publishers.external + 2);
    expect(Object.values(after.publishers.by_host).flatMap((h: any) => h.names)).not.toContain("osintverse");
    expect(after.packages.published).toBeGreaterThanOrEqual(before.packages.published + 2);
    expect(after.installs.last_7d).toBe(before.installs.last_7d + 5);
    expect(after.failed_publishes_7d.count).toBe(before.failed_publishes_7d.count + 1);
    expect(after.sev1_open).toMatchObject({ count: 2 });
    expect(after.exit.no_open_sev1.met).toBe(false);
  });

  it("says why sev-1 issues can't be counted instead of reporting zero", async () => {
    sev1Search = () => new Response("{}", { status: 422 });
    const m = await metrics((await person({ reviewer: true })).auth);
    expect(m.sev1_open.count).toBeNull();
    expect(m.sev1_open.error).toMatch(/422.*ISSUES_TOKEN/);
    expect(m.exit.no_open_sev1.met).toBe(false);
  });
});

// ---------- email test ----------

describe("test email", () => {
  it("sends one to the calling admin and passes Resend's error back", async () => {
    let answer: () => Response | object = () => ({ id: "e" });
    const emails: { to: string[]; subject: string }[] = [];
    fakeHosts({ "POST https://api.resend.com/emails": async (req) => (emails.push(await req.json() as any), answer()) });
    expect((await post("/admin/email-test", (await person({ reviewer: true })).auth)).status).toBe(403);
    const admin = await person();
    await DB().prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).bind(admin.id).run();

    expect(await (await post("/admin/email-test", admin.auth)).json()).toEqual({ status: "sent", to: `${admin.login}@example.com` });
    expect(emails.at(-1)).toMatchObject({ to: [`${admin.login}@example.com`], subject: "OTInstaller test email" });

    answer = () => new Response('{"message":"API key is invalid"}', { status: 401 });
    const bad = await post("/admin/email-test", admin.auth);
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ status: "failed", error: expect.stringMatching(/^401 .*invalid/) });
  });
});