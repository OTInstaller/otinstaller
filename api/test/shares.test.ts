import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { requiredScope } from "../src/scopes";
import { purgeExpiredShares, SHARE_TTL_MS } from "../src/shares";
import { call, testEnv } from "./helpers";

const DB = () => env.DB;
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;
const ip = () => `10.9.${Math.floor(n / 250) % 250}.${++n % 250}`;

async function person(flags: { reviewer?: boolean; scopes?: string } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, is_reviewer, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(id, login, `${login}@example.com`, flags.reviewer ? 1 : 0, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)`)
      .bind(ulid(), id, await sha256Hex(token), flags.scopes ?? "read,publish,manage,feedback", flags.scopes ? 1 : 0, Date.now()),
  ]);
  return { id, login, auth: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}

/** A saved run as `ot share` sends it, with the local details it should have dropped. */
function run(tool = "osintverse-community/sherlock@0.15.0") {
  return {
    envelope: 1, tool, runtime: "docker", input: { username: "johndoe" },
    started_at: "2026-10-27T10:00:00Z", ended_at: "2026-10-27T10:00:42Z", duration_ms: 42000, exit_code: 0,
    entities: [{ type: "account", value: "https://github.com/johndoe", source: "github" }],
    raw: [{ site: "github", url: "https://github.com/johndoe" }], warnings: [],
    run_id: "a1b2c3d4", case: "acme-investigation", command: ["sherlock", "johndoe"], target: "johndoe",
    output: { sha256: "a".repeat(64), bytes: 120, path: "C:\\Users\\pat\\results\\sherlock\\johndoe\\run.json", meta_path: "C:\\Users\\pat\\x.meta.json" },
  };
}

const anon = () => ({ "content-type": "application/json", "cf-connecting-ip": ip() });
const share = (headers: Record<string, string>, body: unknown) => call("/shares", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as any;

describe("sharing results", () => {
  it("stores runs without their local details and serves them to anyone with the link for 24 hours", async () => {
    const res = await share(anon(), { share: 1, source: "ot", runs: [run(), run("osintverse-community/holehe@1.0.0")] });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const made = await json(res);
    expect(made.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.url).toBe(`https://otinstaller.com/r/${made.id}`);
    expect(made.owned).toBe(false);
    expect(made.expires_at - made.created_at).toBe(SHARE_TTL_MS);
    expect(made.tools).toEqual(["osintverse-community/sherlock@0.15.0", "osintverse-community/holehe@1.0.0"]);
    expect(typeof made.delete_token).toBe("string");

    const got = await call(`/shares/${made.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("private, no-store");
    expect(got.headers.get("x-robots-tag")).toBe("noindex");
    const body = await json(got);
    expect(body).not.toHaveProperty("owner_id");
    expect(body.source).toBe("ot");
    expect(body.runs).toHaveLength(2);
    const r = body.runs[0];
    for (const k of ["run_id", "case", "command", "target"]) expect(r).not.toHaveProperty(k);
    expect(r.output).toEqual({ sha256: "a".repeat(64), bytes: 120 });
    expect(r.input).toEqual({ username: "johndoe" });
    expect(r.entities[0].value).toBe("https://github.com/johndoe");
    expect(r.raw).toEqual([{ site: "github", url: "https://github.com/johndoe" }]);

    const row = await DB().prepare(`SELECT owner_id, run_count, source FROM shares WHERE id = ?`).bind(made.id).first<any>();
    expect(row).toEqual({ owner_id: null, run_count: 2, source: "ot" });
  });

  it("takes otlite's envelope, which has no raw or run id", async () => {
    const res = await share(anon(), {
      share: 1, source: "otlite",
      runs: [{ envelope: 1, tool: "sherlock@0.15.0", runtime: "otlite", input: { target: "johndoe" }, status: "complete", entities: [], warnings: [], case: "acme", output: { path: "sherlock/johndoe/x.txt", sha256: "b".repeat(64), bytes: 9 } }],
    });
    expect(res.status).toBe(201);
    const body = await json(await call(`/shares/${(await json(res)).id}`));
    expect(body.runs[0]).not.toHaveProperty("case");
    expect(body.runs[0].output).toEqual({ sha256: "b".repeat(64), bytes: 9 });
  });

  it("refuses uploads that are not share-v1", async () => {
    for (const body of [
      "not json",
      { share: 2, source: "ot", runs: [run()] },
      { share: 1, source: "other", runs: [run()] },
      { share: 1, source: "ot", runs: [] },
      { share: 1, source: "ot", runs: [{ ...run(), tool: "" }] },
      { share: 1, source: "ot", runs: [{ ...run(), input: { username: 1 } }] },
      { share: 1, source: "ot", runs: [{ ...run(), entities: [{ type: "account" }] }] },
      { share: 1, source: "ot", runs: Array.from({ length: 51 }, () => run()) },
    ]) {
      const res = await share(anon(), body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_body");
    }
  });

  it("refuses uploads over 5 MB", async () => {
    const big = { ...run(), raw: "x".repeat(5 * 1_048_576) };
    const res = await share(anon(), { share: 1, source: "ot", runs: [big] });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("share_too_large");
  });

  it("allows 20 anonymous shares an hour from one address", async () => {
    const headers = anon();
    for (let i = 0; i < 20; i++) expect((await share(headers, { share: 1, source: "ot", runs: [run()] })).status).toBe(201);
    const res = await share(headers, { share: 1, source: "ot", runs: [run()] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("answers 410 once the 24 hours are up, and 404 for links that never existed", async () => {
    const made = await json(await share(anon(), { share: 1, source: "ot", runs: [run()] }));
    await DB().prepare(`UPDATE shares SET expires_at = ? WHERE id = ?`).bind(Date.now() - 1, made.id).run();
    const res = await call(`/shares/${made.id}`);
    expect(res.status).toBe(410);
    expect((await json(res)).error.code).toBe("share_expired");
    expect((await call(`/shares/${"A".repeat(22)}`)).status).toBe(404);
    expect((await call("/shares/too-short")).status).toBe(404);
  });

  it("lets whoever holds the delete token delete an anonymous share", async () => {
    const made = await json(await share(anon(), { share: 1, source: "ot", runs: [run()] }));
    const del = (token: string) => call(`/shares/${made.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete_token: token }) });
    const wrong = await del("nope");
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).error.code).toBe("share_forbidden");
    expect((await del(made.delete_token)).status).toBe(204);
    expect((await call(`/shares/${made.id}`)).status).toBe(404);
    expect(await env.CONTENT.get(`shares/${made.id}.json`)).toBeNull();
  });

  it("links a signed-in sharer's shares to them, privately, so they can list and delete them", async () => {
    const me = await person();
    const other = await person();
    const res = await share(me.auth, { share: 1, source: "ot", runs: [run()] });
    expect(res.status).toBe(201);
    const made = await json(res);
    expect(made.owned).toBe(true);
    await share(anon(), { share: 1, source: "ot", runs: [run()] });

    // Viewers learn nothing about the owner.
    const seen = await json(await call(`/shares/${made.id}`));
    expect(JSON.stringify(seen)).not.toContain(me.id);
    expect(JSON.stringify(seen)).not.toContain(me.login);

    const mine = await json(await call("/me/shares", { headers: me.auth }));
    expect(mine.shares.map((s: any) => s.id)).toEqual([made.id]);
    expect(mine.shares[0]).toMatchObject({ url: made.url, run_count: 1, tools: ["osintverse-community/sherlock@0.15.0"], source: "ot" });
    expect((await json(await call("/me/shares", { headers: other.auth }))).shares).toEqual([]);
    expect((await call("/me/shares")).status).toBe(401);

    expect((await call(`/shares/${made.id}`, { method: "DELETE", headers: other.auth })).status).toBe(403);
    expect((await call(`/shares/${made.id}`, { method: "DELETE", headers: me.auth })).status).toBe(204);
    expect((await json(await call("/me/shares", { headers: me.auth }))).shares).toEqual([]);
  });

  it("needs no scope to share, so a read-only token can share too", async () => {
    expect(requiredScope("POST", "/v1/shares")).toBeNull();
    expect(requiredScope("DELETE", "/v1/shares/abc")).toBe("manage");
    const reader = await person({ scopes: "read" });
    const res = await share(reader.auth, { share: 1, source: "ot", runs: [run()] });
    expect(res.status).toBe(201);
    expect((await json(res)).owned).toBe(true);
  });

  it("purges expired shares and their stored runs", async () => {
    const live = await json(await share(anon(), { share: 1, source: "ot", runs: [run()] }));
    const old = await json(await share(anon(), { share: 1, source: "ot", runs: [run()] }));
    await DB().prepare(`UPDATE shares SET expires_at = ? WHERE id = ?`).bind(Date.now() - 1, old.id).run();
    expect(await purgeExpiredShares(await testEnv())).toBeGreaterThanOrEqual(1);
    expect(await DB().prepare(`SELECT 1 FROM shares WHERE id = ?`).bind(old.id).first()).toBeNull();
    expect(await env.CONTENT.get(`shares/${old.id}.json`)).toBeNull();
    expect((await call(`/shares/${live.id}`)).status).toBe(200);
  });

  it("lets staff take a share down", async () => {
    const made = await json(await share(anon(), { share: 1, source: "ot", runs: [run()] }));
    const someone = await person();
    expect((await call(`/admin/shares/${made.id}`, { method: "DELETE", headers: someone.auth })).status).toBe(403);
    const reviewer = await person({ reviewer: true });
    expect((await call(`/admin/shares/${made.id}`, { method: "DELETE", headers: reviewer.auth })).status).toBe(204);
    expect((await call(`/shares/${made.id}`)).status).toBe(404);
    const logged = await DB().prepare(`SELECT actor_id FROM audit_log WHERE action = 'share.remove' AND target_id = ?`).bind(made.id).first<{ actor_id: string }>();
    expect(logged?.actor_id).toBe(reviewer.id);
  });
});
