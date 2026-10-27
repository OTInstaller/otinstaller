// Operations: alerts for stuck publish jobs, the reviewers' daily digest, and error reporting to Sentry.
import { deps, type Env } from "./env";
import { sendEmail, staffEmails, templates } from "./notify";

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
 * Runs one step of the nightly cron. A step that throws is logged and reported to Sentry under one issue per step, and
 * the steps after it still run.
 */
export async function nightly(env: Env, name: string, step: () => Promise<unknown>, now = Date.now()) {
  try {
    await step();
  } catch (e) {
    console.error(`nightly ${name} failed`, e);
    await reportError(env, e, { requestId: `cron-${name}-${new Date(now).toISOString().slice(0, 10)}`, path: `/cron/nightly/${name}`, fingerprint: ["nightly", name] });
  }
}

/**
 * Sends an exception to Sentry (when SENTRY_DSN is set) through its envelope endpoint. Request headers,
 * cookies and bodies are never included. A fingerprint groups events into one issue whatever their stack.
 */
export async function reportError(
  env: Env, err: unknown,
  ctx: { requestId: string; method?: string; path?: string; level?: "error" | "warning"; fingerprint?: string[] },
) {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const project = dsn.pathname.replace(/^\/+/, "");
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId, timestamp: Date.now() / 1000, platform: "javascript", level: ctx.level ?? "error", environment: env.SENTRY_ENVIRONMENT ?? "production",
      server_name: "otinstaller-registry-api", tags: { request_id: ctx.requestId }, fingerprint: ctx.fingerprint,
      transaction: ctx.path ? `${ctx.method ?? "GET"} ${ctx.path.replace(/\/[0-9A-Z]{26}(?=\/|$)/g, "/:id").replace(/\/shares\/[^/]+/, "/shares/:id")}` : undefined,
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
