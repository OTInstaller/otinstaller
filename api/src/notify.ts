// Email through Resend. Every message has an idempotency key, recorded before sending, so a retried
// queue message or callback never emails twice. Without RESEND_API_KEY messages are recorded as skipped.
import { deps, type Env } from "./env";
import { ulid } from "./lib/crypto";

export interface Email {
  to: string[];
  subject: string;
  text: string;
  kind: string;
  key: string; // unique per logical message, e.g. "published:<versionId>"
}

export async function sendEmail(env: Env, msg: Email): Promise<"sent" | "skipped" | "failed" | "duplicate"> {
  const to = [...new Set(msg.to.filter(Boolean))];
  if (to.length === 0) return "skipped";
  const now = Date.now();
  const status = env.RESEND_API_KEY ? "sent" : "skipped";
  const claimed = await env.DB.prepare(
    `INSERT INTO notifications (id, idempotency_key, to_email, subject, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
  ).bind(ulid(now), msg.key, to.join(","), msg.subject, msg.kind, status, now).run();
  if (!claimed.meta.changes) return "duplicate";
  if (!env.RESEND_API_KEY) return "skipped";
  const res = await deps.fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": msg.key },
    body: JSON.stringify({ from: env.EMAIL_FROM ?? "OTInstaller Registry <registry@otinstaller.com>", to, subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) {
    const err = `${res.status} ${(await res.text()).slice(0, 300)}`;
    await env.DB.prepare(`UPDATE notifications SET status = 'failed', error = ? WHERE idempotency_key = ?`).bind(err, msg.key).run();
    return "failed";
  }
  return "sent";
}

/** Emails of a namespace's owners (falling back to their linked accounts' emails). */
export async function ownerEmails(env: Env, namespaceId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(u.email, (SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.email IS NOT NULL LIMIT 1)) AS email
     FROM namespace_members m JOIN users u ON u.id = m.user_id WHERE m.namespace_id = ? AND m.role = 'owner'`,
  ).bind(namespaceId).all<{ email: string | null }>();
  return rows.results.map((r) => r.email).filter((e): e is string => !!e);
}

const footer = (env: Env) => `\n\n--\nOTInstaller Registry · ${env.SITE_URL}/dashboard\nQuestions about a decision: reply to this email or write to abuse@otinstaller.com.`;

export const templates = {
  published: (env: Env, ref: string, version: string, warn: boolean) => ({
    subject: `Published ${ref} ${version}`,
    text: `${ref} ${version} passed all checks and is live:\n${env.SITE_URL}/${ref}\n\nInstall it with: ot install ${ref}` +
      (warn ? `\n\nNote: the scan found high or critical vulnerabilities that have fixes available. See ${env.SITE_URL}/${ref}/security.` : "") + footer(env),
  }),
  inReview: (env: Env, ref: string, version: string) => ({
    subject: `${ref} ${version} is waiting for review`,
    text: `${ref} ${version} passed validation and security scans. Because this is a new publisher, a reviewer checks it before it goes public. Reviews usually take up to 3 business days.` + footer(env),
  }),
  rejected: (env: Env, ref: string, version: string, code: string, message: string) => ({
    subject: `${ref} ${version} was not published`,
    text: `${ref} ${version} was not published.\n\nReason: ${code}\n${message}\n\nDocs: https://otinstaller.com/docs/errors#${code}\n\nFix it and push a new tag.` + footer(env),
  }),
  changesRequested: (env: Env, ns: string, notes: string) => ({
    subject: `Changes requested for ${ns}`,
    text: `A reviewer looked at the first release from ${ns} and asked for changes before it can be published:\n\n${notes}\n\nPush a new tag once you've made them.` + footer(env),
  }),
  namespaceRejected: (env: Env, ns: string, reason: string) => ({
    subject: `${ns} was not approved`,
    text: `Your namespace ${ns} was not approved for the OTInstaller Registry.\n\nReason: ${reason}\n\nYou can appeal once by replying to this email.` + footer(env),
  }),
};
