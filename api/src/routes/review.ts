// The scanner's callback, and the reviewers' queue and decisions.
import type { Context } from "hono";
import type { App, AppEnv, Env } from "../env";
import { apiError } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { applyScanResults, commitStatus, loadVersion, publishVersion, type ScanResults, trimSample } from "../scans";
import { ownerEmails, sendEmail, templates } from "../notify";
import { releasePlan } from "../backups";
import { audit, requireUser } from "./auth";

const MAX_RESULTS = 256 * 1024;

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Shape-checks scanner output; anything malformed is rejected rather than half-applied. */
export function parseResults(body: unknown): ScanResults {
  const r = body as ScanResults;
  const bad = (what: string) => apiError(400, "invalid_scan_results", `scan results: ${what}`);
  if (!r || typeof r !== "object") bad("not an object");
  if (!["pass", "fail", "absent"].includes(r.signature?.status)) bad("signature.status must be pass, fail or absent");
  if (!isCount(r.secrets?.count)) bad("secrets.count must be a count");
  if (!isCount(r.malware?.count)) bad("malware.count must be a count");
  if (!["pass", "fail", "skipped"].includes(r.smoke?.status)) bad("smoke.status must be pass, fail or skipped");
  if (r.smoke.sample !== undefined) r.smoke.sample = trimSample(r.smoke.sample);
  const v = r.vulnerabilities;
  if (v !== null && (typeof v !== "object" || !["critical", "high", "medium", "low", "fixable_critical", "fixable_high"].every((k) => isCount((v as any)[k])))) {
    bad("vulnerabilities must be null or counts");
  }
  return r;
}

export function requireReviewer(c: Context<AppEnv>) {
  const u = requireUser(c);
  if (!u.is_reviewer && !u.is_admin) apiError(403, "forbidden", "reviewers only");
  return u;
}

export function requireAdmin(c: Context<AppEnv>) {
  const u = requireUser(c);
  if (!u.is_admin) apiError(403, "forbidden", "admins only");
  return u;
}

async function namespaceByName(env: Env, name: string) {
  const ns = await env.DB.prepare(`SELECT id, name, status, verified FROM namespaces WHERE name = ?`).bind(name).first<{ id: string; name: string; status: string; verified: number }>();
  if (!ns) apiError(404, "namespace_not_found", `${name} is not a namespace`);
  return ns;
}

async function notes(c: Context<AppEnv>, field: "notes" | "reason", required: boolean): Promise<string> {
  const body = await c.req.json<Record<string, string>>().catch(() => ({}) as Record<string, string>);
  const v = (body[field] ?? "").trim();
  if (required && !v) apiError(400, "invalid_body", `send {${field}}`);
  return v.slice(0, 4000);
}

export function reviewRoutes(app: App) {
  // ---------- scanner callback ----------
  app.post("/internal/scans", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) apiError(401, "unauthenticated", "missing scan token");
    if (Number(c.req.header("content-length") ?? 0) > MAX_RESULTS) apiError(413, "payload_too_large", "scan results are too large");
    const v = await loadVersion(c.env, "v.scan_token_hash = ? AND v.scan_token_expires_at > ? AND v.status = 'scanning'", await sha256Hex(token), Date.now());
    if (!v) apiError(401, "invalid_scan_token", "unknown, expired or already used scan token");
    const results = parseResults(await c.req.json().catch(() => null));
    const out = await applyScanResults(c.env, v, results);
    // A published version is backed up by the scanner right away: these are its signed upload URLs.
    const backup = out.status === "published"
      ? await releasePlan(c.env, v.id).catch((e) => (console.error("backup plan failed", e), null))
      : null;
    return c.json({ status: out.status, verdict: out.verdict, ...(backup ? { backup } : {}) });
  });

  // ---------- review queue ----------
  app.get("/admin/review-queue", async (c) => {
    requireReviewer(c);
    const db = c.env.DB;
    const nss = await db.prepare(
      `SELECT n.id, n.name, n.provider, n.provider_owner_id, n.display_name, n.kind, n.review_notes, n.created_at,
         (SELECT group_concat(u.login) FROM namespace_members m JOIN users u ON u.id = m.user_id WHERE m.namespace_id = n.id) AS members
       FROM namespaces n WHERE n.status = 'pending_review'
       AND EXISTS (SELECT 1 FROM tools t JOIN versions v ON v.tool_id = t.id WHERE t.namespace_id = n.id AND v.status = 'awaiting_review')
       ORDER BY n.created_at`,
    ).all<any>();
    const queue = [];
    for (const n of nss.results) {
      const versions = await db.prepare(
        `SELECT v.id, t.name, v.version, t.repo_url, t.summary, v.manifest_json, v.scan_status, v.signer_identity, v.created_at
         FROM versions v JOIN tools t ON t.id = v.tool_id WHERE t.namespace_id = ? AND v.status = 'awaiting_review' ORDER BY v.created_at`,
      ).bind(n.id).all<any>();
      const items = [];
      for (const v of versions.results) {
        const scans = await db.prepare(`SELECT kind, result, summary_json FROM scans WHERE version_id = ? ORDER BY ran_at`).bind(v.id).all<any>();
        const m = JSON.parse(v.manifest_json);
        items.push({
          version_id: v.id, ref: `${n.name}/${v.name}`, version: v.version, repo_url: v.repo_url, summary: v.summary,
          license: m.license, ethics: m.ethics ?? null, kind: m.kind ?? "tool", scan_status: v.scan_status, signed: !!v.signer_identity,
          scans: scans.results.map((s) => ({ kind: s.kind, result: s.result, summary: JSON.parse(s.summary_json ?? "null") })),
        });
      }
      queue.push({
        namespace: n.name, provider: n.provider, kind: n.kind, display_name: n.display_name, members: n.members ? n.members.split(",") : [],
        profile_url: n.provider === "github" ? `https://github.com/${n.display_name}` : null,
        waiting_since: n.created_at, previous_notes: n.review_notes, versions: items,
      });
    }
    // Releases from approved publishers held for a content review (a guide with possible personal data).
    const held = await db.prepare(
      `SELECT v.id, n.name AS namespace, t.name, v.version, t.repo_url, t.summary, v.manifest_json, v.scan_status, v.created_at
       FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE v.status = 'awaiting_review' AND n.status = 'active' ORDER BY v.created_at`,
    ).all<any>();
    const content_review = [];
    for (const v of held.results) {
      const scans = await db.prepare(`SELECT kind, result, summary_json FROM scans WHERE version_id = ? ORDER BY ran_at`).bind(v.id).all<any>();
      const m = JSON.parse(v.manifest_json);
      content_review.push({
        version_id: v.id, ref: `${v.namespace}/${v.name}`, version: v.version, repo_url: v.repo_url, summary: v.summary,
        license: m.license, kind: m.kind ?? "tool", scan_status: v.scan_status, waiting_since: v.created_at,
        scans: scans.results.map((s) => ({ kind: s.kind, result: s.result, summary: JSON.parse(s.summary_json ?? "null") })),
      });
    }
    return c.json({ queue, content_review });
  });

  app.post("/admin/namespaces/:ns/approve", async (c) => {
    const reviewer = requireReviewer(c);
    const ns = await namespaceByName(c.env, c.req.param("ns"));
    if (ns.status !== "pending_review") apiError(409, "not_pending", `${ns.name} is ${ns.status}`);
    const note = await notes(c, "notes", false);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE namespaces SET status = 'active', reviewed_by = ?, reviewed_at = ?, review_notes = ? WHERE id = ?`).bind(reviewer.id, Date.now(), note || null, ns.id),
      audit(c.env.DB, reviewer.id, "user", "namespace.approve", "namespace", ns.id, { notes: note }),
    ]);
    const waiting = await c.env.DB.prepare(
      `SELECT v.id FROM versions v JOIN tools t ON t.id = v.tool_id WHERE t.namespace_id = ? AND v.status = 'awaiting_review'`,
    ).bind(ns.id).all<{ id: string }>();
    // Each publish makes several outgoing requests (commit status, email), so a namespace with many releases
    // would run past the Worker's per-request limit: they are published from the queue, one per message.
    for (let i = 0; i < waiting.results.length; i += 100) {
      await c.env.PUBLISH_QUEUE.sendBatch(waiting.results.slice(i, i + 100).map((v) => ({ body: { publishVersionId: v.id } })));
    }
    return c.json({ status: "active", queued: waiting.results.length });
  });

  app.post("/admin/namespaces/:ns/request-changes", async (c) => {
    const reviewer = requireReviewer(c);
    const ns = await namespaceByName(c.env, c.req.param("ns"));
    if (ns.status !== "pending_review") apiError(409, "not_pending", `${ns.name} is ${ns.status}`);
    const note = await notes(c, "notes", true);
    const now = Date.now();
    // The waiting versions are closed so the author can fix and re-tag; the namespace stays in review.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE namespaces SET review_notes = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`).bind(note, reviewer.id, now, ns.id),
      c.env.DB.prepare(
        `UPDATE versions SET status = 'rejected', rejected_reason = 'changes_requested' WHERE status = 'awaiting_review' AND tool_id IN (SELECT id FROM tools WHERE namespace_id = ?)`,
      ).bind(ns.id),
      audit(c.env.DB, reviewer.id, "user", "namespace.request_changes", "namespace", ns.id, { notes: note }),
    ]);
    await sendEmail(c.env, { to: await ownerEmails(c.env, ns.id), kind: "changes_requested", key: `changes:${ns.id}:${now}`, ...templates.changesRequested(c.env, ns.name, note) });
    return c.json({ status: "pending_review" });
  });

  app.post("/admin/namespaces/:ns/reject", async (c) => {
    const reviewer = requireReviewer(c);
    const ns = await namespaceByName(c.env, c.req.param("ns"));
    if (ns.status !== "pending_review") apiError(409, "not_pending", `${ns.name} is ${ns.status}`);
    const reason = await notes(c, "reason", true);
    const waiting = await c.env.DB.prepare(
      `SELECT v.id FROM versions v JOIN tools t ON t.id = v.tool_id WHERE t.namespace_id = ? AND v.status = 'awaiting_review'`,
    ).bind(ns.id).all<{ id: string }>();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE namespaces SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_notes = ? WHERE id = ?`).bind(reviewer.id, Date.now(), reason, ns.id),
      c.env.DB.prepare(
        `UPDATE versions SET status = 'rejected', rejected_reason = 'namespace_rejected' WHERE status = 'awaiting_review' AND tool_id IN (SELECT id FROM tools WHERE namespace_id = ?)`,
      ).bind(ns.id),
      audit(c.env.DB, reviewer.id, "user", "namespace.reject", "namespace", ns.id, { reason }),
    ]);
    for (const { id } of waiting.results) {
      const v = await loadVersion(c.env, "v.id = ?", id);
      if (v) await commitStatus(c.env, v, "failure", "namespace_rejected: see the email from the registry");
    }
    await sendEmail(c.env, { to: await ownerEmails(c.env, ns.id), kind: "namespace_rejected", key: `ns_rejected:${ns.id}`, ...templates.namespaceRejected(c.env, ns.name, reason) });
    return c.json({ status: "rejected" });
  });

  // ---------- single releases (content review) ----------

  const heldVersion = async (c: Context<AppEnv>) => {
    const v = await loadVersion(c.env, "v.id = ?", c.req.param("id"));
    if (!v) apiError(404, "version_not_found", "no such version");
    if (v.status !== "awaiting_review") apiError(409, "not_pending", `this version is ${v.status}`);
    // A new publisher's releases are decided with the namespace, so the whole first release is seen together.
    if (v.namespace_status !== "active") apiError(409, "namespace_in_review", `${v.namespace} is ${v.namespace_status}; decide on the namespace instead`);
    return v;
  };

  app.post("/admin/versions/:id/approve", async (c) => {
    const reviewer = requireReviewer(c);
    const v = await heldVersion(c);
    const note = await notes(c, "notes", false);
    await audit(c.env.DB, reviewer.id, "user", "version.approve", "version", v.id, { notes: note }).run();
    await publishVersion(c.env, v.id);
    return c.json({ status: "published" });
  });

  app.post("/admin/versions/:id/reject", async (c) => {
    const reviewer = requireReviewer(c);
    const v = await heldVersion(c);
    const reason = await notes(c, "reason", true);
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE versions SET status = 'rejected', rejected_reason = 'review_rejected' WHERE id = ?`).bind(v.id),
      c.env.DB.prepare(`UPDATE publish_jobs SET status = 'rejected', error_code = 'review_rejected', error_detail = ?, updated_at = ? WHERE version_id = ?`).bind(reason, now, v.id),
      audit(c.env.DB, reviewer.id, "user", "version.reject", "version", v.id, { reason }),
    ]);
    await commitStatus(c.env, v, "failure", "review_rejected: see the email from the registry");
    await sendEmail(c.env, {
      to: await ownerEmails(c.env, v.namespace_id), kind: "rejected", key: `review_rejected:${v.id}`,
      ...templates.rejected(c.env, `${v.namespace}/${v.name}`, v.version, "review_rejected", reason),
    });
    return c.json({ status: "rejected" });
  });

  app.post("/admin/namespaces/:ns/verify", async (c) => {
    const admin = requireAdmin(c);
    const ns = await namespaceByName(c.env, c.req.param("ns"));
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE namespaces SET verified = 1 WHERE id = ?`).bind(ns.id),
      audit(c.env.DB, admin.id, "user", "namespace.verify", "namespace", ns.id),
    ]);
    return c.json({ verified: true });
  });

  app.post("/admin/namespaces/:ns/suspend", async (c) => {
    const admin = requireAdmin(c);
    const ns = await namespaceByName(c.env, c.req.param("ns"));
    const reason = await notes(c, "reason", true);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE namespaces SET status = 'suspended', review_notes = ? WHERE id = ?`).bind(reason, ns.id),
      audit(c.env.DB, admin.id, "user", "namespace.suspend", "namespace", ns.id, { reason }),
    ]);
    return c.json({ status: "suspended" });
  });
}
