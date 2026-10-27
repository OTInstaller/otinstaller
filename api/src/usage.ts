// Usage counts: how often each package is installed and run, kept as daily totals with no address, user or token.
// `ot` sends POST /installs after each install and POST /runs with a command's runs (routes/usage.ts). The nightly cron
// folds the last 30 days into tools.installs_30d and runs_30d (refreshUsage), and staff read the totals on the admin
// Usage tab (usageReport). An address is counted once per package and day, held only as a salted hash in rate_limits
// (trust.ts), which the nightly purge deletes after a day. Tables: migration 0044.
import type { Env } from "./env";
import { apiError } from "./lib/errors";
import { hitStatement, rateKey } from "./trust";

const DAY = 86_400_000;

// ---------- what ot may send ----------

/** How a run ended. The first five started; the rest never got as far as running the tool. */
export const OUTCOMES = ["ok", "empty", "error", "timeout", "interrupted", "engine_error", "no_engine", "not_started", "missing_key"] as const;
/** Outcomes of runs that started: what run counts, failure rates and durations are made of. */
export const STARTED: readonly string[] = ["ok", "empty", "error", "timeout", "interrupted"];
export const INSTALL_FAILURES = ["no_engine", "pull_failed", "verify_failed", "build_failed", "refused", "interrupted", "error"] as const;
const CLIENTS = ["cli", "ci", "mcp"];
const ENGINES = ["docker", "podman", "native", "none"];
const VIAS = ["run", "all", "playbook", "auto", "mcp"];
const OSES = ["linux", "darwin", "windows", "freebsd", "openbsd", "netbsd"];
const ARCHES = ["amd64", "arm64", "386", "arm", "riscv64", "ppc64le", "s390x"];
/** AI clients `ot mcp` names (from the client's own name, matched by ot); anything else is "other". */
export const MCP_CLIENTS = ["claude_code", "claude_desktop", "cursor", "vscode", "codex", "gemini", "windsurf", "zed", "cline", "continue", "goose"];
const MILESTONES = ["first_install", "first_run", "first_ok_run"];

const REF = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]\/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Per POST, and per address and day, so one machine (or one CI loop) can't make a package look popular. */
export const LIMITS = { body: 32 * 1024, runs: 100, failures: 50, refsPerQuery: 30, runsPerTool: 200, runsPerAddress: 2000 };

export type RunRow = { tool: string; version: string; outcome: string; duration_ms: number; engine: string; via: string };
export type FailureRow = { tool: string; version: string; reason: string };
export type RunsInput = {
  client: string; os: string; arch: string; ot_version: string; mcp_client: string | null;
  runs: RunRow[]; failures: FailureRow[]; milestones: string[];
};
export type InstallInput = { tool: string; version: string; client: string; from_backup: boolean; first: boolean };

const pick = (v: unknown, allowed: readonly string[]) => (typeof v === "string" && allowed.includes(v) ? v : "other");
const isRef = (tool: unknown, version: unknown) =>
  typeof tool === "string" && REF.test(tool) && typeof version === "string" && version.length <= 64 && SEMVER.test(version);
const refKey = (tool: string, version: string) => `${tool}@${version}`;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Checks a POST /installs body: {tool: "ns/name", version, client?, from_backup?, first?}. */
export function installInput(body: unknown): InstallInput {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const [ns, name] = typeof b.tool === "string" ? b.tool.split("/") : [];
  if (!ns || !name || typeof b.version !== "string" || !b.version) apiError(400, "invalid_body", "send {tool: 'namespace/name', version}");
  return { tool: b.tool as string, version: b.version, client: pick(b.client, CLIENTS), from_backup: b.from_backup === true, first: b.first === true };
}

/**
 * Checks a POST /runs body. A wrong shape is a 400. Rows with an unknown package, outcome or reason are dropped and
 * unknown engines, systems and clients become "other", so a newer ot can send values this API doesn't know yet.
 */
export function runsInput(body: unknown): RunsInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) apiError(400, "invalid_body", "send {client, runs: [{tool, version, outcome, duration_ms}]}");
  const b = body as Record<string, unknown>;
  const list = (key: string, max: number): unknown[] => {
    const v = b[key] ?? [];
    if (!Array.isArray(v) || v.length > max) apiError(400, "invalid_body", `${key} must be a list of at most ${max}`);
    return v;
  };
  const objects = (key: string, max: number) =>
    list(key, max).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
  const client = pick(b.client, CLIENTS);
  const runs = objects("runs", LIMITS.runs).flatMap((r) =>
    isRef(r.tool, r.version) && (OUTCOMES as readonly string[]).includes(r.outcome as string)
      ? [{
          tool: r.tool as string, version: r.version as string, outcome: r.outcome as string,
          duration_ms: Math.min(Math.max(Math.round(Number(r.duration_ms) || 0), 0), DAY),
          engine: pick(r.engine, ENGINES), via: pick(r.via, VIAS),
        }]
      : []);
  const failures = objects("install_failures", LIMITS.failures).flatMap((f) =>
    isRef(f.tool, f.version) && (INSTALL_FAILURES as readonly string[]).includes(f.reason as string)
      ? [{ tool: f.tool as string, version: f.version as string, reason: f.reason as string }]
      : []);
  const milestones = [...new Set(list("milestones", MILESTONES.length * 2).filter((m): m is string => typeof m === "string" && MILESTONES.includes(m)))];
  const otVersion = typeof b.ot_version === "string" && b.ot_version.length <= 32 && SEMVER.test(b.ot_version) ? b.ot_version : "other";
  return {
    client, os: pick(b.os, OSES), arch: pick(b.arch, ARCHES), ot_version: otVersion,
    mcp_client: client === "mcp" ? pick(b.mcp_client, MCP_CLIENTS) : null,
    runs, failures, milestones,
  };
}

// ---------- counting ----------

type Resolved = { tool_id: string; version_id: string };

/**
 * The published or yanked versions behind tool@version refs, following transferred packages' old addresses as findTool
 * does. Removed packages and versions are left out. 30 refs a query keeps under D1's 100 bound parameters.
 */
async function resolveRefs(db: D1Database, refs: { tool: string; version: string }[]): Promise<Map<string, Resolved>> {
  const found = new Map<string, Resolved>();
  const unique = [...new Map(refs.map((r) => [refKey(r.tool, r.version), r])).values()];
  const lookup = async (sql: string, list: typeof unique) => {
    const rows = await db.prepare(sql.replace("$VALUES", list.map(() => "(?, ?, ?)").join(", ")))
      .bind(...list.flatMap((r) => [...r.tool.split("/"), r.version]))
      .all<{ tool: string; version: string } & Resolved>();
    for (const r of rows.results) if (!found.has(refKey(r.tool, r.version))) found.set(refKey(r.tool, r.version), { tool_id: r.tool_id, version_id: r.version_id });
  };
  for (let i = 0; i < unique.length; i += LIMITS.refsPerQuery) {
    const chunk = unique.slice(i, i + LIMITS.refsPerQuery);
    await lookup(
      `SELECT n.name || '/' || t.name AS tool, v.version, t.id AS tool_id, v.id AS version_id
       FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.tool_id = t.id
       WHERE t.status != 'removed' AND v.status IN ('published', 'yanked') AND (n.name, t.name, v.version) IN (VALUES $VALUES)`,
      chunk,
    );
    const moved = chunk.filter((r) => !found.has(refKey(r.tool, r.version)));
    if (moved.length) {
      await lookup(
        `SELECT a.old_namespace || '/' || a.old_name AS tool, v.version, t.id AS tool_id, v.id AS version_id
         FROM aliases a JOIN tools t ON t.id = a.tool_id JOIN versions v ON v.tool_id = t.id
         WHERE t.status != 'removed' AND v.status IN ('published', 'yanked') AND (a.old_namespace, a.old_name, v.version) IN (VALUES $VALUES)`,
        moved,
      );
    }
  }
  return found;
}

const daily = (db: D1Database, day: string, dim: string, value: string, n: number) =>
  db.prepare(
    `INSERT INTO usage_daily (day, dim, value, count) VALUES (?, ?, ?, ?)
     ON CONFLICT (day, dim, value) DO UPDATE SET count = count + excluded.count`,
  ).bind(day, dim, value, n);

const installOutcome = (db: D1Database, v: Resolved, day: string, outcome: string, n: number) =>
  db.prepare(
    `INSERT INTO install_outcomes (tool_id, version_id, day, outcome, count) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tool_id, day, version_id, outcome) DO UPDATE SET count = count + excluded.count`,
  ).bind(v.tool_id, v.version_id, day, outcome, n);

/**
 * Counts one install: once per address, package version and day, with the kind of client, whether it came from the
 * registry's backups, and the machine's first install. Old ot sends only tool, version and client. Without an address
 * (local runs) every install counts.
 */
export async function recordInstall(env: Env, address: string | null, input: InstallInput, now = Date.now()) {
  if (!isRef(input.tool, input.version)) return;
  const db = env.DB;
  const v = (await resolveRefs(db, [input])).get(refKey(input.tool, input.version));
  if (!v) return;
  const day = utcDay(now);
  let counted = true;
  let firstToday = false;
  let milestone = input.first;
  if (address) {
    const hits = [
      // The same key overLimit("install", ...) used before 0044, so a deploy doesn't count anyone twice that day.
      hitStatement(db, await rateKey(env, "install", `${address}|${v.version_id}`), DAY, 1, now),
      hitStatement(db, await rateKey(env, "installed", address), DAY, 1, now),
      ...(input.first ? [hitStatement(db, await rateKey(env, "milestone", `${address}|first_install`), DAY, 1, now)] : []),
    ];
    const counts = (await db.batch<{ count: number }>(hits)).map((r) => r.results[0]?.count ?? 0);
    counted = counts[0] === 1;
    firstToday = counts[1] === 1;
    milestone = input.first && counts[2] === 1;
  }
  const writes: D1PreparedStatement[] = [];
  if (counted) {
    writes.push(db.prepare(
      `INSERT INTO install_counts (tool_id, version_id, day, client, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (tool_id, day, version_id, client) DO UPDATE SET count = count + 1`,
    ).bind(v.tool_id, v.version_id, day, input.client));
    if (input.from_backup) writes.push(installOutcome(db, v, day, "from_backup", 1));
  }
  if (firstToday) writes.push(daily(db, day, "addresses", "installed", 1));
  if (milestone) writes.push(daily(db, day, "milestone", "first_install", 1));
  if (writes.length) await db.batch(writes);
}

/**
 * Counts one POST /runs. Rows for packages the registry doesn't have are dropped. With an address, a package counts at
 * most limits.runsPerTool of its runs a day, the address limits.runsPerAddress rows in all, and the address is a runner
 * of each package it ran once a day. Without one (local runs) everything counts and nobody is a runner.
 */
export async function recordRuns(env: Env, address: string | null, input: RunsInput, now = Date.now(), limits = LIMITS) {
  const db = env.DB;
  const day = utcDay(now);
  const refs = await resolveRefs(db, [...input.runs, ...input.failures]);
  const runs = input.runs.flatMap((r) => {
    const v = refs.get(refKey(r.tool, r.version));
    return v ? [{ ...r, ...v }] : [];
  });
  const failures = input.failures.flatMap((f) => {
    const v = refs.get(refKey(f.tool, f.version));
    return v ? [{ ...f, ...v }] : [];
  });
  if (!runs.length && !failures.length && !input.milestones.length) return;

  // How much of this POST counts.
  const tools = new Map<string, { sent: number; started: boolean; allowed: number; runner: boolean }>();
  for (const r of runs) {
    const t = tools.get(r.tool_id) ?? { sent: 0, started: false, allowed: Infinity, runner: false };
    t.sent++;
    t.started ||= STARTED.includes(r.outcome);
    tools.set(r.tool_id, t);
  }
  const anyStarted = runs.some((r) => STARTED.includes(r.outcome));
  let allowance = Infinity;
  let firstRan = false;
  let milestones = input.milestones;
  if (address) {
    const rows = runs.length + failures.length;
    const toolHits = [...tools].map(async ([id, t]) => hitStatement(db, await rateKey(env, "runs", `${address}|${id}`), DAY, t.sent, now));
    const runnerHits = [...tools].filter(([, t]) => t.started).map(async ([id]) => hitStatement(db, await rateKey(env, "runner", `${address}|${id}`), DAY, 1, now));
    const milestoneHits = input.milestones.map(async (m) => hitStatement(db, await rateKey(env, "milestone", `${address}|${m}`), DAY, 1, now));
    const stmts = await Promise.all([
      ...toolHits, ...runnerHits,
      (async () => hitStatement(db, await rateKey(env, "runs-address", address), DAY, rows, now))(),
      // Addresses that ran anything today, counted on their first started run.
      ...(anyStarted ? [(async () => hitStatement(db, await rateKey(env, "ran", address), DAY, 1, now))()] : []),
      ...milestoneHits,
    ]);
    const counts = (await db.batch<{ count: number }>(stmts)).map((r) => r.results[0]?.count ?? 0);
    let i = 0;
    for (const t of tools.values()) {
      const after = counts[i++]!;
      t.allowed = Math.max(0, Math.min(t.sent, limits.runsPerTool - (after - t.sent)));
    }
    for (const t of tools.values()) if (t.started) t.runner = counts[i++] === 1;
    const after = counts[i++]!;
    allowance = Math.max(0, Math.min(rows, limits.runsPerAddress - (after - rows)));
    if (anyStarted) firstRan = counts[i++] === 1;
    milestones = input.milestones.filter((_, j) => counts[i + j] === 1);
  }

  const runRows = new Map<string, { v: Resolved; outcome: string; count: number; duration: number }>();
  const dims = new Map<string, number>();
  const dim = (name: string, value: string, n = 1) => dims.set(`${name}\t${value}`, (dims.get(`${name}\t${value}`) ?? 0) + n);
  const used = new Map<string, number>();
  let counted = 0;
  for (const r of runs) {
    const u = used.get(r.tool_id) ?? 0;
    if (u >= tools.get(r.tool_id)!.allowed || counted >= allowance) continue;
    used.set(r.tool_id, u + 1);
    counted++;
    const key = `${r.version_id}\t${r.outcome}`;
    const row = runRows.get(key) ?? { v: r, outcome: r.outcome, count: 0, duration: 0 };
    row.count++;
    if (STARTED.includes(r.outcome)) row.duration += r.duration_ms;
    runRows.set(key, row);
    dim("engine", r.engine);
    dim("via", r.via);
  }
  if (counted) {
    dim("os", input.os, counted);
    dim("arch", input.arch, counted);
    dim("ot_version", input.ot_version, counted);
    if (input.mcp_client) dim("mcp_client", input.mcp_client, counted);
  }
  if (firstRan) dim("addresses", "ran");
  for (const m of milestones) dim("milestone", m);
  const failureRows = new Map<string, { v: Resolved; reason: string; count: number }>();
  for (const f of failures) {
    if (counted >= allowance) break;
    counted++;
    const key = `${f.version_id}\t${f.reason}`;
    const row = failureRows.get(key) ?? { v: f, reason: f.reason, count: 0 };
    row.count++;
    failureRows.set(key, row);
  }

  const writes: D1PreparedStatement[] = [
    ...[...runRows.values()].map((r) => db.prepare(
      `INSERT INTO run_counts (tool_id, version_id, day, client, outcome, count, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool_id, day, version_id, client, outcome) DO UPDATE SET count = count + excluded.count, duration_ms = duration_ms + excluded.duration_ms`,
    ).bind(r.v.tool_id, r.v.version_id, day, input.client, r.outcome, r.count, r.duration)),
    ...[...tools].filter(([, t]) => t.runner).map(([id]) => db.prepare(
      `INSERT INTO run_runners (tool_id, day, runners) VALUES (?, ?, 1) ON CONFLICT (tool_id, day) DO UPDATE SET runners = runners + 1`,
    ).bind(id, day)),
    ...[...failureRows.values()].map((f) => installOutcome(db, f.v, day, f.reason, f.count)),
    ...[...dims].map(([key, n]) => {
      const [name, value] = key.split("\t") as [string, string];
      return daily(db, day, name, value, n);
    }),
  ];
  if (writes.length) await db.batch(writes);
}

// ---------- nightly ----------

/**
 * Each package's installs and runs (runs that started) in the last 30 days, today included, and all time, onto tools,
 * where search, ranking and summaries read them. Only rows whose number changed are written; returns how many were.
 */
export async function refreshUsage(env: Env, now = Date.now()): Promise<number> {
  const since = utcDay(now - 29 * DAY);
  const started = `c.outcome IN (${STARTED.map((o) => `'${o}'`).join(", ")})`;
  const update = (column: string, table: string, on: string) => env.DB.prepare(
    `UPDATE tools SET ${column} = x.n FROM (
       SELECT t.id, COALESCE(SUM(c.count), 0) AS n FROM tools t LEFT JOIN ${table} c ON c.tool_id = t.id ${on} GROUP BY t.id
     ) AS x WHERE x.id = tools.id AND tools.${column} != x.n`,
  );
  const results = await env.DB.batch([
    update("installs_30d", "install_counts", "AND c.day >= ?").bind(since),
    update("runs_30d", "run_counts", `AND c.day >= ? AND ${started}`).bind(since),
    update("installs_total", "install_counts", ""),
    update("runs_total", "run_counts", `AND ${started}`),
  ]);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

// ---------- the staff report ----------

type Counts = Record<string, number>;
const RUN_CLIENTS = ["cli", "ci", "mcp", "other"];
const INSTALL_CLIENTS = ["cli", "ci", "mcp", "other", "unknown"];
const zeros = (keys: readonly string[]): Counts => Object.fromEntries(keys.map((k) => [k, 0]));
const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 1000 : null);
const STARTED_SQL = `outcome IN (${STARTED.map((o) => `'${o}'`).join(", ")})`;

/** Success, failure and empty rates over runs that finished (interrupted ones are left out), and the mean duration. */
function rates(outcomes: Counts, durationMs: number) {
  const finished = (outcomes.ok ?? 0) + (outcomes.empty ?? 0) + (outcomes.error ?? 0) + (outcomes.timeout ?? 0);
  const started = finished + (outcomes.interrupted ?? 0);
  return {
    success_rate: share((outcomes.ok ?? 0) + (outcomes.empty ?? 0), finished),
    error_rate: share(outcomes.error ?? 0, finished),
    timeout_rate: share(outcomes.timeout ?? 0, finished),
    empty_rate: share(outcomes.empty ?? 0, finished),
    mean_duration_ms: started > 0 ? Math.round(durationMs / started) : null,
  };
}

/**
 * What the admin Usage tab shows: totals for the last `days` days (today included) against the days before, a daily
 * series, the registry-wide dimensions, and the 200 packages with the most runs. With `tool` (ns/name), also that
 * package by version and by day.
 */
export async function usageReport(env: Env, days: number, tool: string | null, now = Date.now()) {
  const db = env.DB;
  const from = utcDay(now - (days - 1) * DAY);
  const prevFrom = utcDay(now - (2 * days - 1) * DAY);
  const outcomeSums = OUTCOMES.map((o) => `SUM(CASE WHEN day >= ?1 AND outcome = '${o}' THEN count ELSE 0 END) AS o_${o}`).join(", ");
  const clientSums = (clients: string[], extra: string) =>
    clients.map((k) => `SUM(CASE WHEN day >= ?1 ${extra} AND client = '${k}' THEN count ELSE 0 END) AS c_${k}`).join(", ");
  type ToolRuns = { tool_id: string; runs: number; runs_prev: number; duration_ms: number } & Counts;
  type ToolInstalls = { tool_id: string; installs: number; installs_prev: number } & Counts;
  const [runsQ, installsQ, runnersQ, failuresQ, dimsQ, runDaysQ, installDaysQ, addressDaysQ, refsQ] = await db.batch([
    db.prepare(
      `SELECT tool_id,
         SUM(CASE WHEN day >= ?1 AND ${STARTED_SQL} THEN count ELSE 0 END) AS runs,
         SUM(CASE WHEN day < ?1 AND ${STARTED_SQL} THEN count ELSE 0 END) AS runs_prev,
         SUM(CASE WHEN day >= ?1 AND ${STARTED_SQL} THEN duration_ms ELSE 0 END) AS duration_ms,
         ${outcomeSums}, ${clientSums(RUN_CLIENTS, `AND ${STARTED_SQL}`)}
       FROM run_counts WHERE day >= ?2 GROUP BY tool_id`,
    ).bind(from, prevFrom),
    db.prepare(
      `SELECT tool_id, SUM(CASE WHEN day >= ?1 THEN count ELSE 0 END) AS installs, SUM(CASE WHEN day < ?1 THEN count ELSE 0 END) AS installs_prev,
         ${clientSums(INSTALL_CLIENTS, "")}
       FROM install_counts WHERE day >= ?2 GROUP BY tool_id`,
    ).bind(from, prevFrom),
    db.prepare(`SELECT tool_id, SUM(runners) AS runner_days FROM run_runners WHERE day >= ? GROUP BY tool_id`).bind(from),
    db.prepare(`SELECT tool_id, outcome, SUM(count) AS n FROM install_outcomes WHERE day >= ? GROUP BY tool_id, outcome`).bind(from),
    db.prepare(`SELECT dim, value, SUM(count) AS n FROM usage_daily WHERE day >= ? AND dim != 'addresses' GROUP BY dim, value`).bind(from),
    db.prepare(
      `SELECT day, SUM(CASE WHEN ${STARTED_SQL} THEN count ELSE 0 END) AS runs, SUM(CASE WHEN outcome IN ('ok', 'empty') THEN count ELSE 0 END) AS ok,
         SUM(CASE WHEN outcome IN ('error', 'timeout') THEN count ELSE 0 END) AS failed
       FROM run_counts WHERE day >= ? GROUP BY day`,
    ).bind(from),
    db.prepare(`SELECT day, SUM(count) AS installs FROM install_counts WHERE day >= ? GROUP BY day`).bind(from),
    db.prepare(`SELECT day, value, count FROM usage_daily WHERE dim = 'addresses' AND day >= ?`).bind(from),
    db.prepare(
      `SELECT t.id, n.name || '/' || t.name AS ref FROM tools t JOIN namespaces n ON n.id = t.namespace_id
       WHERE t.id IN (SELECT tool_id FROM run_counts WHERE day >= ?1 UNION SELECT tool_id FROM install_counts WHERE day >= ?1
         UNION SELECT tool_id FROM install_outcomes WHERE day >= ?1)`,
    ).bind(prevFrom),
  ]);
  const refs = new Map(((refsQ?.results ?? []) as { id: string; ref: string }[]).map((r) => [r.id, r.ref]));
  const runsBy = new Map(((runsQ?.results ?? []) as ToolRuns[]).map((r) => [r.tool_id, r]));
  const installsBy = new Map(((installsQ?.results ?? []) as ToolInstalls[]).map((r) => [r.tool_id, r]));
  const runnersBy = new Map(((runnersQ?.results ?? []) as { tool_id: string; runner_days: number }[]).map((r) => [r.tool_id, r.runner_days]));
  const failuresBy = new Map<string, Counts>();
  for (const f of (failuresQ?.results ?? []) as { tool_id: string; outcome: string; n: number }[]) {
    failuresBy.set(f.tool_id, { ...(failuresBy.get(f.tool_id) ?? {}), [f.outcome]: f.n });
  }

  const totals = {
    installs: 0, installs_prev: 0, runs: 0, runs_prev: 0, runner_days: 0, duration_ms: 0,
    outcomes: zeros(OUTCOMES), clients: { runs: zeros(RUN_CLIENTS), installs: zeros(INSTALL_CLIENTS) },
  };
  const packages = [...refs].map(([id, ref]) => {
    const r = runsBy.get(id);
    const i = installsBy.get(id);
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, r?.[`o_${o}`] ?? 0]));
    const clients = Object.fromEntries(RUN_CLIENTS.map((k) => [k, r?.[`c_${k}`] ?? 0]));
    const installClients = Object.fromEntries(INSTALL_CLIENTS.map((k) => [k, i?.[`c_${k}`] ?? 0]));
    const { from_backup: fromBackup = 0, ...installFailures } = failuresBy.get(id) ?? {};
    const row = {
      ref,
      installs: i?.installs ?? 0, installs_prev: i?.installs_prev ?? 0,
      runs: r?.runs ?? 0, runs_prev: r?.runs_prev ?? 0, runner_days: runnersBy.get(id) ?? 0,
      outcomes, ...rates(outcomes, r?.duration_ms ?? 0), clients, install_clients: installClients,
      install_failures: installFailures, from_backup: fromBackup,
    };
    totals.installs += row.installs;
    totals.installs_prev += row.installs_prev;
    totals.runs += row.runs;
    totals.runs_prev += row.runs_prev;
    totals.runner_days += row.runner_days;
    totals.duration_ms += r?.duration_ms ?? 0;
    for (const o of OUTCOMES) totals.outcomes[o]! += outcomes[o]!;
    for (const k of RUN_CLIENTS) totals.clients.runs[k]! += clients[k]!;
    for (const k of INSTALL_CLIENTS) totals.clients.installs[k]! += installClients[k]!;
    return row;
  });

  const dims: Record<string, Counts> = {};
  for (const d of (dimsQ?.results ?? []) as { dim: string; value: string; n: number }[]) (dims[d.dim] ??= {})[d.value] = d.n;
  const runDays = new Map(((runDaysQ?.results ?? []) as { day: string; runs: number; ok: number; failed: number }[]).map((d) => [d.day, d]));
  const installDays = new Map(((installDaysQ?.results ?? []) as { day: string; installs: number }[]).map((d) => [d.day, d.installs]));
  const addressDays = new Map<string, Counts>();
  for (const a of (addressDaysQ?.results ?? []) as { day: string; value: string; count: number }[]) {
    addressDays.set(a.day, { ...(addressDays.get(a.day) ?? {}), [a.value]: a.count });
  }
  const series = (rows: Map<string, { runs: number; ok: number; failed: number }>, installs: Map<string, number>, addresses?: Map<string, Counts>) =>
    Array.from({ length: days }, (_, k) => {
      const d = utcDay(now - (days - 1 - k) * DAY);
      const r = rows.get(d);
      return {
        day: d, installs: installs.get(d) ?? 0, runs: r?.runs ?? 0, ok: r?.ok ?? 0, failed: r?.failed ?? 0,
        ...(addresses ? { addresses_ran: addresses.get(d)?.ran ?? 0, addresses_installed: addresses.get(d)?.installed ?? 0 } : {}),
      };
    });
  const { duration_ms: durationMs, ...totalsOut } = totals;

  return {
    window: { days, from, to: utcDay(now), previous_from: prevFrom, previous_to: utcDay(now - days * DAY) },
    totals: { ...totalsOut, ...rates(totals.outcomes, durationMs) },
    daily: series(runDays, installDays, addressDays),
    dims,
    tools: packages.sort((a, b) => b.runs - a.runs || b.installs - a.installs || a.ref.localeCompare(b.ref)).slice(0, 200),
    ...(tool ? { tool: await toolReport(env, tool, from, days, now, series) } : {}),
  };
}

/** One package by version and by day, for the Usage tab's drill-down. */
async function toolReport(
  env: Env, ref: string, from: string, days: number, now: number,
  series: (rows: Map<string, { runs: number; ok: number; failed: number }>, installs: Map<string, number>) => unknown[],
) {
  const db = env.DB;
  const [ns, name] = ref.split("/");
  const t = await db.prepare(`SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`)
    .bind(ns ?? "", name ?? "").first<{ id: string }>();
  if (!t) apiError(404, "tool_not_found", `${ref} is not in the registry`);
  const [versionRuns, versionInstalls, runDays, installDays] = await db.batch([
    db.prepare(
      `SELECT COALESCE(v.version, '?') AS version, rc.outcome, SUM(rc.count) AS n, SUM(rc.duration_ms) AS ms
       FROM run_counts rc LEFT JOIN versions v ON v.id = rc.version_id WHERE rc.tool_id = ? AND rc.day >= ? GROUP BY rc.version_id, rc.outcome`,
    ).bind(t.id, from),
    db.prepare(
      `SELECT COALESCE(v.version, '?') AS version, SUM(ic.count) AS n
       FROM install_counts ic LEFT JOIN versions v ON v.id = ic.version_id WHERE ic.tool_id = ? AND ic.day >= ? GROUP BY ic.version_id`,
    ).bind(t.id, from),
    db.prepare(
      `SELECT day, SUM(CASE WHEN ${STARTED_SQL} THEN count ELSE 0 END) AS runs, SUM(CASE WHEN outcome IN ('ok', 'empty') THEN count ELSE 0 END) AS ok,
         SUM(CASE WHEN outcome IN ('error', 'timeout') THEN count ELSE 0 END) AS failed
       FROM run_counts WHERE tool_id = ? AND day >= ? GROUP BY day`,
    ).bind(t.id, from),
    db.prepare(`SELECT day, SUM(count) AS installs FROM install_counts WHERE tool_id = ? AND day >= ? GROUP BY day`).bind(t.id, from),
  ]);
  const versions = new Map<string, { version: string; installs: number; runs: number; outcomes: Counts; duration_ms: number }>();
  const version = (v: string) => versions.get(v) ?? versions.set(v, { version: v, installs: 0, runs: 0, outcomes: zeros(OUTCOMES), duration_ms: 0 }).get(v)!;
  for (const r of (versionRuns?.results ?? []) as { version: string; outcome: string; n: number; ms: number }[]) {
    const v = version(r.version);
    v.outcomes[r.outcome] = (v.outcomes[r.outcome] ?? 0) + r.n;
    if (STARTED.includes(r.outcome)) {
      v.runs += r.n;
      v.duration_ms += r.ms;
    }
  }
  for (const r of (versionInstalls?.results ?? []) as { version: string; n: number }[]) version(r.version).installs += r.n;
  return {
    ref,
    versions: [...versions.values()]
      .map(({ duration_ms: ms, ...v }) => ({ ...v, ...rates(v.outcomes, ms) }))
      .sort((a, b) => b.runs - a.runs || b.installs - a.installs),
    daily: series(
      new Map(((runDays?.results ?? []) as { day: string; runs: number; ok: number; failed: number }[]).map((d) => [d.day, d])),
      new Map(((installDays?.results ?? []) as { day: string; installs: number }[]).map((d) => [d.day, d.installs])),
    ),
  };
}
