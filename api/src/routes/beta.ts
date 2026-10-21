// The closed beta: feedback from the site and `ot feedback`, its triage queue, and the metrics the beta's
// exit criteria are measured by (external publishers by host, installs, failed publishes, open sev-1 bugs).
import type { Context } from "hono";
import type { App, AppEnv, Env } from "../env";
import { deps } from "../env";
import { apiError, rateLimited, windowRetry } from "../lib/errors";
import { ulid } from "../lib/crypto";
import { audit } from "./auth";
import { requireAdmin, requireReviewer } from "./review";
import { sendEmail } from "../notify";
import { overLimit } from "../trust";
import { COMMUNITY_NAMESPACE } from "../imports";

export const FEEDBACK_KINDS = ["bug", "idea", "question", "other"] as const;
// Namespaces the OSINTverse team publishes; they don't count towards the beta's external authors.
const FIRST_PARTY = ["osintverse", COMMUNITY_NAMESPACE];
// Bug reports are GitHub issues labelled by the severity the reporter picked (.github/ISSUE_TEMPLATE/bug.yml).
export const SEV1_LABEL = "sev-1";

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Open sev-1 issues on the issue tracker, or null with the reason when GitHub can't be asked. */
async function openSev1(env: Env): Promise<{ count: number | null; url: string; error?: string }> {
  const repo = env.ISSUES_REPO ?? "OTInstaller/feedback";
  const url = `https://github.com/${repo}/issues?q=${encodeURIComponent(`is:issue is:open label:${SEV1_LABEL}`)}`;
  const q = encodeURIComponent(`repo:${repo} is:issue is:open label:${SEV1_LABEL}`);
  const res = await deps.fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "otinstaller-registry",
      ...(env.ISSUES_TOKEN ? { Authorization: `Bearer ${env.ISSUES_TOKEN}` } : {}),
    },
  }).catch(() => null);
  if (!res?.ok) {
    // A private repository answers 422 to an anonymous search.
    const why = res ? `GitHub answered ${res.status}` : "GitHub could not be reached";
    return { count: null, url, error: `${why}${env.ISSUES_TOKEN ? "" : "; set ISSUES_TOKEN (Issues: read) while the repository is private"}` };
  }
  const body = (await res.json()) as { total_count?: number };
  return { count: body.total_count ?? 0, url };
}

export function betaRoutes(app: App) {
  // Anyone can send feedback; signed-in users are linked to it. 10 an hour per user or address.
  app.post("/feedback", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const kind = text(b.kind, 20) || "other";
    if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) apiError(400, "invalid_kind", `kind must be one of: ${FEEDBACK_KINDS.join(", ")}`);
    const message = text(b.message, 5000);
    if (message.length < 3) apiError(400, "invalid_body", "send {message}, at least a few words");
    const email = text(b.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) apiError(400, "invalid_email", "that email address doesn't look right", "leave it empty if you don't want a reply");
    const source = b.source === "cli" ? "cli" : "web";
    const user = c.get("user");
    const limited = user
      ? await overLimit(c.env, "feedback-user", user.id, 10, 3_600_000)
      : await overLimit(c.env, "feedback-ip", c.req.header("cf-connecting-ip") ?? "unknown", 10, 3_600_000);
    if (limited) rateLimited("too_many_requests", "at most 10 messages an hour", "write to registry@otinstaller.com", windowRetry(3_600_000), 10, 3600);
    const id = ulid();
    await c.env.DB.prepare(
      `INSERT INTO feedback (id, user_id, kind, message, email, page, source, client, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, user?.id ?? null, kind, message, email || null, text(b.page, 300) || null, source, text(b.client, 100) || null, Date.now()).run();
    return c.json({ id, status: "open", note: "Thank you. The team reads every message; for a bug that blocks you, also open an issue." }, 201);
  });

  app.get("/admin/feedback", async (c) => {
    requireReviewer(c);
    const status = c.req.query("status") ?? "open";
    if (!["open", "done", "dismissed", "all"].includes(status)) apiError(400, "invalid_parameter", "status must be open, done, dismissed or all");
    const rows = await c.env.DB.prepare(
      `SELECT f.id, f.kind, f.message, f.email, f.page, f.source, f.client, f.status, f.note, f.created_at, f.resolved_at,
         u.login AS sender, ru.login AS resolved_by
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN users ru ON ru.id = f.resolved_by
       WHERE (? = 'all' OR f.status = ?) ORDER BY (f.kind = 'bug') DESC, f.created_at DESC LIMIT 200`,
    ).bind(status, status).all();
    c.header("Cache-Control", "private, no-store");
    return c.json({ feedback: rows.results });
  });

  app.post("/admin/feedback/:id/resolve", async (c) => {
    const reviewer = requireReviewer(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const status = b.status === "done" || b.status === "dismissed" || b.status === "open" ? b.status : null;
    if (!status) apiError(400, "invalid_body", "send {status: 'done' | 'dismissed' | 'open', note?}");
    const note = text(b.note, 2000);
    const f = await c.env.DB.prepare(`SELECT id FROM feedback WHERE id = ?`).bind(c.req.param("id")).first<{ id: string }>();
    if (!f) apiError(404, "feedback_not_found", "no such feedback");
    const open = status === "open";
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE feedback SET status = ?, note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
        .bind(status, note || null, open ? null : reviewer.id, open ? null : Date.now(), f.id),
      audit(c.env.DB, reviewer.id, "user", `feedback.${status}`, "feedback", f.id, { note }),
    ]);
    return c.json({ id: f.id, status });
  });

  app.get("/admin/beta-metrics", (c) => betaMetrics(c));

  // Sends a test email to the calling admin, to check RESEND_API_KEY after it changes. Answers with Resend's error.
  app.post("/admin/email-test", async (c) => {
    const admin = requireAdmin(c);
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(u.email, (SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.email IS NOT NULL LIMIT 1)) AS email
       FROM users u WHERE u.id = ?`,
    ).bind(admin.id).first<{ email: string | null }>();
    if (!row?.email) apiError(409, "no_email", "your account has no email address to send to");
    const key = `email-test:${admin.id}:${Date.now()}`;
    const status = await sendEmail(c.env, {
      to: [row.email], kind: "test", key, subject: "OTInstaller test email",
      text: `This is a test email from the OTInstaller Registry, sent by ${admin.login} from the admin API.\n\n${c.env.SITE_URL}`,
    });
    const failed = status === "failed"
      ? await c.env.DB.prepare(`SELECT error FROM notifications WHERE idempotency_key = ?`).bind(key).first<{ error: string | null }>()
      : null;
    return c.json({ status, to: row.email, ...(failed ? { error: failed.error } : {}) }, status === "failed" ? 502 : 200);
  });
}

async function betaMetrics(c: Context<AppEnv>) {
  requireReviewer(c);
  const db = c.env.DB;
  const fp = FIRST_PARTY.map(() => "?").join(", ");
  const weekAgo = Date.now() - 7 * 86_400_000;
  const [hosts, packages, installs, failed, feedback, sev1] = await Promise.all([
    // External publishers: namespaces outside the first-party ones with at least one published version.
    db.prepare(
      `SELECT n.provider, COUNT(*) AS publishers, group_concat(n.name, ', ') AS names FROM namespaces n
       WHERE n.name NOT IN (${fp}) AND EXISTS (
         SELECT 1 FROM tools t JOIN versions v ON v.tool_id = t.id WHERE t.namespace_id = n.id AND v.status = 'published')
       GROUP BY n.provider`,
    ).bind(...FIRST_PARTY).all<{ provider: string; publishers: number; names: string }>(),
    db.prepare(
      `SELECT COUNT(*) AS total, SUM(n.name NOT IN (${fp})) AS external, SUM(t.kind = 'guide') AS guides FROM tools t
       JOIN namespaces n ON n.id = t.namespace_id WHERE t.status != 'removed' AND t.latest_version_id IS NOT NULL`,
    ).bind(...FIRST_PARTY).first<{ total: number; external: number | null; guides: number | null }>(),
    db.prepare(
      `SELECT COALESCE(SUM(count), 0) AS total, COALESCE(SUM(CASE WHEN day >= date('now', '-7 days') THEN count END), 0) AS last_7d FROM install_counts`,
    ).first<{ total: number; last_7d: number }>(),
    db.prepare(
      `SELECT j.id, j.provider, j.repo, j.tag, j.status, j.error_code, j.error_detail, j.updated_at FROM publish_jobs j
       WHERE j.status IN ('rejected', 'error') AND COALESCE(j.updated_at, j.created_at) >= ? ORDER BY COALESCE(j.updated_at, j.created_at) DESC LIMIT 50`,
    ).bind(weekAgo).all<Record<string, unknown>>(),
    db.prepare(`SELECT kind, COUNT(*) AS open FROM feedback WHERE status = 'open' GROUP BY kind`).all<{ kind: string; open: number }>(),
    openSev1(c.env),
  ]);
  const byHost = Object.fromEntries(["github", "gitlab"].map((p) => [p, { publishers: 0, names: [] as string[] }]));
  for (const h of hosts.results) byHost[h.provider] = { publishers: h.publishers, names: h.names ? h.names.split(", ") : [] };
  const external = Object.values(byHost).reduce((n, h) => n + h.publishers, 0);
  c.header("Cache-Control", "private, no-store");
  return c.json({
    publishers: { external, by_host: byHost },
    packages: { published: packages?.total ?? 0, external: packages?.external ?? 0, guides: packages?.guides ?? 0 },
    installs: installs ?? { total: 0, last_7d: 0 },
    failed_publishes_7d: { count: failed.results.length, recent: failed.results },
    feedback_open: Object.fromEntries(feedback.results.map((f) => [f.kind, f.open])),
    sev1_open: sev1,
    // The plan's exit criteria for the closed beta.
    exit: {
      external_publishers: { target: 10, met: external >= 10 },
      gitlab_publishers: { target: 3, met: (byHost.gitlab?.publishers ?? 0) >= 3 },
      no_open_sev1: { met: sev1.count === 0 },
    },
  });
}
