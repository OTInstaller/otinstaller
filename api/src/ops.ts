// Operations: nightly health checks (run by the health workflow in registry-ops), alerts for stuck publish
// jobs, the reviewers' daily digest, and error reporting to Sentry.
import { deps, type Env } from "./env";
import { ulid } from "./lib/crypto";
import { ownerEmails, sendEmail, staffEmails, templates } from "./notify";

export const BROKEN_AFTER = 3;
const KEEP_CHECKS = 30;

/** What the health workflow should check tonight: every listed tool's latest version that has a test input. */
export async function healthTargets(env: Env) {
  const rows = (await env.DB.prepare(
    `SELECT t.id AS tool_id, v.id AS version_id, n.name AS namespace, t.name, v.version, v.manifest_json
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
     WHERE t.kind = 'tool' AND t.status != 'removed' AND n.status = 'active' AND json_extract(v.manifest_json, '$.test.input') IS NOT NULL
     ORDER BY t.id`,
  ).all<{ tool_id: string; version_id: string; namespace: string; name: string; version: string; manifest_json: string }>()).results;
  return rows.map((r) => {
    const m = JSON.parse(r.manifest_json);
    return {
      version_id: r.version_id, ref: `${r.namespace}/${r.name}`, version: r.version, runtime: m.runtime, test_input: m.test.input,
      expect_exit_code: m.test.expect_exit_code ?? 0,
      domains: m.network?.domains ?? [],
    };
  });
}

export type HealthResult = { version_id: string; result: "pass" | "fail"; duration_ms?: number; error_excerpt?: string; failure?: string };

const FAILURE_CLASSES = ["exit_code", "timeout", "no_output", "pull_failed"];

/**
 * What kind of failure a check was, for the public health history (the excerpt itself stays private): what the
 * runner says, else a guess from the excerpt.
 */
export function failureClass(r: HealthResult): string | null {
  if (r.result === "pass") return null;
  if (r.failure && FAILURE_CLASSES.includes(r.failure)) return r.failure;
  const text = r.error_excerpt ?? "";
  if (/timed? ?out|deadline exceeded/i.test(text)) return "timeout";
  if (/manifest unknown|pull access denied|unauthorized|failed to pull|error pulling|no such image/i.test(text)) return "pull_failed";
  return text.trim() ? "exit_code" : "no_output";
}

/**
 * Records results. A tool is Possibly broken after BROKEN_AFTER failures in a row and healthy after one pass;
 * its owners get one email when a run of failures starts, not every night.
 */
export async function applyHealth(env: Env, results: HealthResult[], now = Date.now()) {
  const db = env.DB;
  let applied = 0;
  for (const r of results) {
    const t = await db.prepare(
      `SELECT t.id, t.namespace_id, t.health_fail_streak, n.name AS ns, t.name, v.version FROM versions v JOIN tools t ON t.id = v.tool_id
       JOIN namespaces n ON n.id = t.namespace_id WHERE v.id = ?`,
    ).bind(r.version_id).first<{ id: string; namespace_id: string; health_fail_streak: number; ns: string; name: string; version: string }>();
    if (!t || (r.result !== "pass" && r.result !== "fail")) continue;
    const streak = r.result === "pass" ? 0 : t.health_fail_streak + 1;
    const status = r.result === "pass" ? "healthy" : streak >= BROKEN_AFTER ? "broken" : null;
    await db.batch([
      db.prepare(`INSERT INTO health_checks (id, tool_id, version_id, result, duration_ms, error_excerpt, failure_class, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(ulid(now), t.id, r.version_id, r.result, r.duration_ms ?? null, (r.error_excerpt ?? "").slice(-1000) || null, failureClass(r), now),
      db.prepare(`UPDATE tools SET health_fail_streak = ?, health_checked_at = ?, health_status = COALESCE(?, health_status) WHERE id = ?`)
        .bind(streak, now, status, t.id),
      db.prepare(`DELETE FROM health_checks WHERE tool_id = ? AND id NOT IN (SELECT id FROM health_checks WHERE tool_id = ? ORDER BY ran_at DESC LIMIT ?)`)
        .bind(t.id, t.id, KEEP_CHECKS),
    ]);
    if (streak === 1) {
      await sendEmail(env, {
        to: await ownerEmails(env, t.namespace_id), kind: "health", key: `health-failing:${t.id}:${now}`,
        ...templates.healthFailing(env, `${t.ns}/${t.name}`, t.version, r.error_excerpt ?? ""),
      });
    }
    applied++;
  }
  return applied;
}

/** Jobs not finished within 30 minutes (each reported once). */
export async function alertStuckJobs(env: Env, now = Date.now()) {
  const jobs = (await env.DB.prepare(
    `SELECT id, repo, tag, status, created_at FROM publish_jobs
     WHERE status IN ('queued', 'validating', 'scanning') AND created_at < ? ORDER BY created_at LIMIT 50`,
  ).bind(now - 30 * 60_000).all<{ id: string; repo: string; tag: string; status: string; created_at: number }>()).results;
  if (jobs.length === 0) return 0;
  const key = `stuck:${jobs.map((j) => j.id).join(",")}`.slice(0, 500);
  await sendEmail(env, {
    to: await staffEmails(env, "admins"), kind: "alert", key,
    ...templates.stuckJobs(env, jobs.map((j) => ({ ...j, age_min: Math.round((now - j.created_at) / 60_000) }))),
  });
  return jobs.length;
}

/** Business days between two times (weekends skipped). */
export function businessDays(from: number, to: number): number {
  let days = 0;
  for (let t = from + 86_400_000; t <= to; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) days++;
  }
  return days;
}

/** The reviewers' daily digest: namespaces waiting more than 2 business days and reports older than 48 hours. */
export async function dailyDigest(env: Env, now = Date.now()) {
  const waiting = (await env.DB.prepare(
    `SELECT n.name, MIN(v.created_at) AS since FROM namespaces n JOIN tools t ON t.namespace_id = n.id JOIN versions v ON v.tool_id = t.id
     WHERE n.status = 'pending_review' AND v.status = 'awaiting_review' GROUP BY n.id`,
  ).all<{ name: string; since: number }>()).results
    .map((w) => ({ name: w.name, days: businessDays(w.since, now) })).filter((w) => w.days > 2);
  const reports = (await env.DB.prepare(
    `SELECT n.name || '/' || t.name AS ref, r.reason, r.created_at FROM reports r JOIN tools t ON t.id = r.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE r.status = 'open' AND r.created_at < ?`,
  ).bind(now - 48 * 3_600_000).all<{ ref: string; reason: string; created_at: number }>()).results
    .map((r) => ({ ref: r.ref, reason: r.reason, hours: Math.round((now - r.created_at) / 3_600_000) }));
  if (waiting.length === 0 && reports.length === 0) return null;
  await sendEmail(env, {
    to: await staffEmails(env, "reviewers"), kind: "digest", key: `digest:${new Date(now).toISOString().slice(0, 10)}`,
    ...templates.dailyDigest(env, waiting, reports),
  });
  return { waiting: waiting.length, reports: reports.length };
}

/** Rate-limit windows older than a day. */
export async function purgeRateLimits(env: Env, now = Date.now()) {
  await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(now - 86_400_000).run();
}

/**
 * Sends an exception to Sentry (when SENTRY_DSN is set) through its envelope endpoint. Request headers,
 * cookies and bodies are never included.
 */
export async function reportError(env: Env, err: unknown, ctx: { requestId: string; method?: string; path?: string }) {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const project = dsn.pathname.replace(/^\/+/, "");
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId, timestamp: Date.now() / 1000, platform: "javascript", level: "error", environment: env.SENTRY_ENVIRONMENT ?? "production",
      server_name: "otinstaller-registry-api", tags: { request_id: ctx.requestId },
      transaction: ctx.path ? `${ctx.method ?? "GET"} ${ctx.path.replace(/\/[0-9A-Z]{26}(?=\/|$)/g, "/:id")}` : undefined,
      exception: { values: [{ type: e.name, value: e.message, stacktrace: e.stack ? { frames: e.stack.split("\n").slice(1, 30).reverse().map((l) => ({ function: l.trim() })) } : undefined }] },
    };
    const body = `${JSON.stringify({ event_id: eventId, dsn: env.SENTRY_DSN, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    await deps.fetch(`${dsn.protocol}//${dsn.host}/api/${project}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=otinstaller/1.0` },
      body,
    });
  } catch (e) {
    console.error("reporting to Sentry failed", e);
  }
}
