import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex, ulid } from "../src/lib/crypto";
import { nightly } from "../src/ops";
import { LIMITS, recordRuns, refreshUsage, runsInput } from "../src/usage";
import worker from "../src/index";
import { call, fakeHosts, testEnv } from "./helpers";

const DB = () => env.DB;
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
let n = 0;
const uniq = () => `${Date.now() % 1e6}${String(++n).padStart(4, "0")}`;

async function person(flags: { reviewer?: boolean } = {}) {
  const id = ulid();
  const login = `u${uniq()}`;
  const token = `ot_test_${id}`;
  await DB().batch([
    DB().prepare(`INSERT INTO users (id, login, email, is_reviewer, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
      .bind(id, login, `${login}@example.com`, flags.reviewer ? 1 : 0, Date.now()),
    DB().prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, 'test', ?, ?)`).bind(ulid(), id, await sha256Hex(token), Date.now()),
  ]);
  return { id, login, auth: { authorization: `Bearer ${token}` } };
}

/** A package with the given versions (the last one is the latest), in its own namespace. */
async function pkg(versions: [string, string][] = [["1.0.0", "published"]]) {
  const ns = `ns${uniq()}`;
  const name = `tool${uniq()}`;
  const nsId = ulid();
  const toolId = ulid();
  const ids: Record<string, string> = {};
  const now = Date.now();
  const stmts = [
    DB().prepare(`INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, status, created_at) VALUES (?, 'github', ?, ?, 'user', 'active', ?)`)
      .bind(nsId, uniq(), ns, now),
    DB().prepare(`INSERT INTO tools (id, namespace_id, kind, name, summary, created_at, updated_at) VALUES (?, ?, 'tool', ?, 'x', ?, ?)`)
      .bind(toolId, nsId, name, now, now),
  ];
  for (const [version, status] of versions) {
    ids[version] = ulid();
    const [major, minor, patch] = version.split(".").map(Number);
    stmts.push(DB().prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, manifest_json, runtime_kind, status, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', 'docker', ?, ?, ?)`,
    ).bind(ids[version], toolId, version, major, minor, patch, status, now, now));
  }
  stmts.push(DB().prepare(`UPDATE tools SET latest_version_id = ? WHERE id = ?`).bind(ids[versions.at(-1)![0]], toolId));
  await DB().batch(stmts);
  return { ref: `${ns}/${name}`, ns, name, toolId, versionIds: ids };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const run = (tool: string, outcome: string, extra: Record<string, unknown> = {}) =>
  ({ tool, version: "1.0.0", outcome, duration_ms: 1000, engine: "docker", via: "run", ...extra });
const batch = (runs: unknown[], extra: Record<string, unknown> = {}) =>
  ({ ot_version: "0.16.0", client: "cli", os: "linux", arch: "amd64", runs, ...extra });

async function outcomes(toolId: string) {
  const rows = await DB().prepare(`SELECT outcome, client, SUM(count) AS n, SUM(duration_ms) AS ms FROM run_counts WHERE tool_id = ? GROUP BY outcome, client`)
    .bind(toolId).all<{ outcome: string; client: string; n: number; ms: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.outcome, r]));
}
const dim = async (name: string, value: string) =>
  (await DB().prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM usage_daily WHERE day = ? AND dim = ? AND value = ?`).bind(today(), name, value).first<{ n: number }>())!.n;
const runners = async (toolId: string) =>
  (await DB().prepare(`SELECT COALESCE(SUM(runners), 0) AS n FROM run_runners WHERE tool_id = ?`).bind(toolId).first<{ n: number }>())!.n;

// ---------- POST /runs ----------

describe("run counts", () => {
  it("counts runs by version, client and outcome, with the durations of runs that started", async () => {
    const p = await pkg();
    const linux = await dim("os", "linux");
    const res = await post("/runs", batch([
      run(p.ref, "ok", { duration_ms: 1000 }), run(p.ref, "ok", { duration_ms: 3000 }), run(p.ref, "error"),
      run(p.ref, "no_engine", { duration_ms: 500, engine: "none" }),
    ]), { "cf-connecting-ip": "203.0.113.20" });
    expect(res.status).toBe(204);
    const o = await outcomes(p.toolId);
    expect(o.ok).toMatchObject({ client: "cli", n: 2, ms: 4000 });
    expect(o.error).toMatchObject({ n: 1, ms: 1000 });
    // It never ran, so it adds no time.
    expect(o.no_engine).toMatchObject({ n: 1, ms: 0 });
    expect((await dim("os", "linux")) - linux).toBe(4);
  });

  it("counts an address as a runner of a package once a day", async () => {
    const p = await pkg();
    const ran = await dim("addresses", "ran");
    await post("/runs", batch([run(p.ref, "ok")]), { "cf-connecting-ip": "203.0.113.21" });
    await post("/runs", batch([run(p.ref, "ok"), run(p.ref, "empty")]), { "cf-connecting-ip": "203.0.113.21" });
    expect(await runners(p.toolId)).toBe(1);
    await post("/runs", batch([run(p.ref, "error")]), { "cf-connecting-ip": "203.0.113.22" });
    expect(await runners(p.toolId)).toBe(2);
    // Runs that never started don't make a runner.
    await post("/runs", batch([run(p.ref, "missing_key")]), { "cf-connecting-ip": "203.0.113.23" });
    expect(await runners(p.toolId)).toBe(2);
    expect((await dim("addresses", "ran")) - ran).toBe(2);
    expect((await outcomes(p.toolId)).ok?.n).toBe(2);
  });

  it("drops unknown packages and outcomes and removed versions, counts yanked ones, and follows old addresses", async () => {
    const p = await pkg([["0.8.0", "removed"], ["0.9.0", "yanked"], ["1.0.0", "published"]]);
    await DB().prepare(`INSERT INTO aliases (old_namespace, old_name, tool_id, created_at) VALUES (?, ?, ?, ?)`)
      .bind("old-home", p.name, p.toolId, Date.now()).run();
    const res = await post("/runs", batch([
      run(p.ref, "ok"), run(p.ref, "ok", { version: "0.9.0" }), run(p.ref, "ok", { version: "0.8.0" }),
      run("nobody/nothing", "ok"), run(p.ref, "exploded"), run(`old-home/${p.name}`, "timeout"), run("not a ref", "ok"),
    ]));
    expect(res.status).toBe(204);
    const byVersion = await DB().prepare(`SELECT version_id, outcome, count FROM run_counts WHERE tool_id = ? ORDER BY version_id, outcome`)
      .bind(p.toolId).all<{ version_id: string; outcome: string; count: number }>();
    expect(byVersion.results).toEqual(expect.arrayContaining([
      { version_id: p.versionIds["1.0.0"], outcome: "ok", count: 1 },
      { version_id: p.versionIds["1.0.0"], outcome: "timeout", count: 1 },
      { version_id: p.versionIds["0.9.0"], outcome: "ok", count: 1 },
    ]));
    expect(byVersion.results).toHaveLength(3);
  });

  it("caps what one address adds to a package and in all, and never stores the address", async () => {
    const a = await pkg();
    const b = await pkg();
    const limits = { ...LIMITS, runsPerTool: 3, runsPerAddress: 5 };
    const address = "198.51.100.9";
    const e = await testEnv();
    await recordRuns(e, address, runsInput(batch([run(a.ref, "ok"), run(a.ref, "ok"), run(a.ref, "ok"), run(a.ref, "ok")])), Date.now(), limits);
    expect((await outcomes(a.toolId)).ok?.n).toBe(3);
    // Four rows so far: this batch's four would make eight, and the address may add five in all.
    await recordRuns(e, address, runsInput(batch([run(a.ref, "ok"), run(a.ref, "ok"), run(b.ref, "ok"), run(b.ref, "ok")])), Date.now(), limits);
    expect((await outcomes(a.toolId)).ok?.n).toBe(3);
    expect((await outcomes(b.toolId)).ok?.n).toBe(1);
    const keys = await DB().prepare(`SELECT key FROM rate_limits`).all<{ key: string }>();
    expect(keys.results.some((k) => k.key.includes(address))).toBe(false);
    expect(JSON.stringify(await DB().prepare(`SELECT * FROM usage_daily`).all())).not.toContain(address);
  });

  it("counts milestones once per address a day, and install failures by reason", async () => {
    const p = await pkg();
    const first = await dim("milestone", "first_run");
    const body = batch([run(p.ref, "ok")], { milestones: ["first_run", "first_ok_run", "made_up"], install_failures: [{ tool: p.ref, version: "1.0.0", reason: "pull_failed" }] });
    await post("/runs", body, { "cf-connecting-ip": "203.0.113.30" });
    await post("/runs", body, { "cf-connecting-ip": "203.0.113.30" });
    expect((await dim("milestone", "first_run")) - first).toBe(1);
    const failures = await DB().prepare(`SELECT outcome, count FROM install_outcomes WHERE tool_id = ?`).bind(p.toolId).all();
    expect(failures.results).toEqual([{ outcome: "pull_failed", count: 2 }]);
  });

  it("keeps an MCP client's name only from the known list", async () => {
    const p = await pkg();
    const cursor = await dim("mcp_client", "cursor");
    const other = await dim("mcp_client", "other");
    await post("/runs", batch([run(p.ref, "ok", { via: "mcp" })], { client: "mcp", mcp_client: "cursor" }));
    await post("/runs", batch([run(p.ref, "ok", { via: "mcp" })], { client: "mcp", mcp_client: "my-secret-agent v2" }));
    expect((await dim("mcp_client", "cursor")) - cursor).toBe(1);
    expect((await dim("mcp_client", "other")) - other).toBe(1);
    expect((await outcomes(p.toolId)).ok).toMatchObject({ client: "mcp", n: 2 });
  });

  it("takes counts only from programs, and checks the body", async () => {
    const p = await pkg();
    const web = await post("/runs", batch([run(p.ref, "ok")]), { origin: "https://evil.example" });
    expect(web.status).toBe(403);
    expect(((await web.json()) as any).error.code).toBe("foreign_origin");
    expect((await post("/installs", { tool: p.ref, version: "1.0.0" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/runs", "[]")).status).toBe(400);
    expect((await post("/runs", "{not json")).status).toBe(400);
    expect((await post("/runs", { runs: "many" })).status).toBe(400);
    expect((await post("/runs", batch(Array.from({ length: 101 }, () => run(p.ref, "ok"))))).status).toBe(400);
    expect((await post("/runs", batch([]))).status).toBe(204);
    expect(await outcomes(p.toolId)).toEqual({});
  });
});

// ---------- POST /installs ----------

describe("install counts", () => {
  it("records the kind of client, installs from backups and first installs", async () => {
    const p = await pkg();
    const installed = await dim("addresses", "installed");
    const firsts = await dim("milestone", "first_install");
    const send = (body: Record<string, unknown>) => post("/installs", { tool: p.ref, version: "1.0.0", ...body }, { "cf-connecting-ip": "203.0.113.40" });
    expect((await send({ client: "mcp", from_backup: true, first: true })).status).toBe(204);
    // The same address and version again that day counts nothing.
    expect((await send({ client: "mcp", from_backup: true, first: true })).status).toBe(204);
    const rows = await DB().prepare(`SELECT client, count FROM install_counts WHERE tool_id = ?`).bind(p.toolId).all();
    expect(rows.results).toEqual([{ client: "mcp", count: 1 }]);
    const backups = await DB().prepare(`SELECT outcome, count FROM install_outcomes WHERE tool_id = ?`).bind(p.toolId).all();
    expect(backups.results).toEqual([{ outcome: "from_backup", count: 1 }]);
    expect((await dim("addresses", "installed")) - installed).toBe(1);
    expect((await dim("milestone", "first_install")) - firsts).toBe(1);
  });
});

// ---------- nightly ----------

describe("nightly totals", () => {
  it("refreshes 30-day and all-time totals of runs that started, and only rewrites what changed", async () => {
    const p = await pkg();
    const v = p.versionIds["1.0.0"];
    await DB().batch([
      ...([[today(), "ok", 5], [daysAgo(29), "error", 2], [daysAgo(30), "ok", 7], [today(), "no_engine", 4]] as const).map(([day, outcome, count]) =>
        DB().prepare(`INSERT INTO run_counts (tool_id, version_id, day, client, outcome, count) VALUES (?, ?, ?, 'cli', ?, ?)`).bind(p.toolId, v, day, outcome, count)),
      ...([[today(), 3], [daysAgo(30), 9]] as const).map(([day, count]) =>
        DB().prepare(`INSERT INTO install_counts (tool_id, version_id, day, client, count) VALUES (?, ?, ?, 'cli', ?)`).bind(p.toolId, v, day, count)),
    ]);
    const e = await testEnv();
    expect(await refreshUsage(e)).toBeGreaterThan(0);
    const t = await DB().prepare(`SELECT installs_30d, installs_total, runs_30d, runs_total FROM tools WHERE id = ?`).bind(p.toolId).first();
    expect(t).toEqual({ installs_30d: 3, installs_total: 12, runs_30d: 7, runs_total: 14 });
    expect(await refreshUsage(e)).toBe(0);
    // Summaries and search carry the 30-day runs.
    const { results } = (await (await call(`/tools?sort=runs&limit=100`)).json()) as any;
    expect(results.find((r: any) => r.name === p.name)?.runs_30d).toBe(7);
    for (let i = 1; i < results.length; i++) expect(results[i - 1].runs_30d).toBeGreaterThanOrEqual(results[i].runs_30d);
  });

  it("runs the refresh from the nightly cron", async () => {
    const p = await pkg();
    await DB().prepare(`INSERT INTO run_counts (tool_id, version_id, day, client, outcome, count) VALUES (?, ?, ?, 'mcp', 'ok', 4)`)
      .bind(p.toolId, p.versionIds["1.0.0"], today()).run();
    fakeHosts({});
    await worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, await testEnv());
    expect(await DB().prepare(`SELECT runs_30d FROM tools WHERE id = ?`).bind(p.toolId).first("runs_30d")).toBe(4);
  });

  it("reports a failing nightly step and carries on", async () => {
    const calls = fakeHosts({ "POST https://sentry.example/": {} });
    const e = { ...(await testEnv()), SENTRY_DSN: "https://key@sentry.example/1" };
    let after = false;
    await nightly(e, "boom", async () => { throw new Error("boom"); });
    await nightly(e, "fine", async () => { after = true; });
    expect(after).toBe(true);
    const sent = calls.filter((c) => c.url === "https://sentry.example/api/1/envelope/");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(`"fingerprint":["nightly","boom"]`);
  });
});

// ---------- the staff report ----------

describe("usage report", () => {
  it("is for reviewers, and reports packages, versions and days", async () => {
    const p = await pkg([["0.9.0", "published"], ["1.0.0", "published"]]);
    await post("/runs", batch([run(p.ref, "ok"), run(p.ref, "ok"), run(p.ref, "error"), run(p.ref, "no_engine"), run(p.ref, "ok", { version: "0.9.0" })]), { "cf-connecting-ip": "203.0.113.50" });
    await post("/installs", { tool: p.ref, version: "1.0.0", client: "ci" }, { "cf-connecting-ip": "203.0.113.50" });

    expect((await call("/admin/usage")).status).toBe(401);
    expect((await call("/admin/usage", { headers: (await person()).auth })).status).toBe(403);
    const reviewer = await person({ reviewer: true });
    const res = await call("/admin/usage?days=7", { headers: reviewer.auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as any;
    expect(body.window).toMatchObject({ days: 7, to: today() });
    expect(body.daily).toHaveLength(7);
    const row = body.tools.find((t: any) => t.ref === p.ref);
    expect(row).toMatchObject({
      installs: 1, runs: 4, runner_days: 1,
      outcomes: { ok: 3, error: 1, no_engine: 1 },
      clients: { cli: 4 }, install_clients: { ci: 1 },
      success_rate: 0.75, error_rate: 0.25, mean_duration_ms: 1000,
    });
    expect(body.totals.runs).toBeGreaterThanOrEqual(4);

    const one = (await (await call(`/admin/usage?tool=${p.ref}`, { headers: reviewer.auth })).json()) as any;
    expect(one.tool.versions).toEqual([
      expect.objectContaining({ version: "1.0.0", runs: 3, installs: 1 }),
      expect.objectContaining({ version: "0.9.0", runs: 1, installs: 0 }),
    ]);
    expect(one.tool.daily.at(-1)).toMatchObject({ day: today(), runs: 4, installs: 1, ok: 3, failed: 1 });
    expect((await call("/admin/usage?days=365", { headers: reviewer.auth })).status).toBe(400);
    expect((await call("/admin/usage?tool=nobody/nothing", { headers: reviewer.auth })).status).toBe(404);
  });
});
