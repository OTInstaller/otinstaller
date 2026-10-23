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
  /** Extra headers, such as List-Unsubscribe on community emails. */
  headers?: Record<string, string>;
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
    body: JSON.stringify({ from: env.EMAIL_FROM ?? "OTInstaller Registry <registry@otinstaller.com>", to, subject: msg.subject, text: msg.text, ...(msg.headers ? { headers: msg.headers } : {}) }),
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

/** Emails of reviewers (and admins), or of admins only. */
export async function staffEmails(env: Env, who: "reviewers" | "admins"): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(u.email, (SELECT a.email FROM accounts a WHERE a.user_id = u.id AND a.email IS NOT NULL LIMIT 1)) AS email
     FROM users u WHERE u.banned_at IS NULL AND (u.is_admin = 1 ${who === "reviewers" ? "OR u.is_reviewer = 1" : ""})`,
  ).all<{ email: string | null }>();
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
  contentReview: (env: Env, ref: string, version: string, hits: number) => ({
    subject: `${ref} ${version} is waiting for review`,
    text: `${ref} ${version} passed its checks, but ${hits} line(s) look like they contain personal data (email addresses, phone numbers, or names next to addresses). ` +
      `A reviewer checks them before the guide goes public. Examples should use fictional data, your own data, or public figures in their public role.` + footer(env),
  }),
  rejected: (env: Env, ref: string, version: string, code: string, message: string) => ({
    subject: `${ref} ${version} was not published`,
    text: `${ref} ${version} was not published.\n\nReason: ${code}\n${message}\n\nDocs: https://otinstaller.com/docs/errors#${code}\n\nFix it and push a new tag.` + footer(env),
  }),
  changesRequested: (env: Env, ns: string, notes: string) => ({
    subject: `Changes requested for ${ns}`,
    text: `A reviewer looked at the first release from ${ns} and asked for changes before it can be published:\n\n${notes}\n\nPush a new tag once you've made them.` + footer(env),
  }),
  removed: (env: Env, ref: string, version: string | null, category: string, reason: string) => ({
    subject: `${ref}${version ? ` ${version}` : ""} was removed from the registry`,
    text: `${version ? `Version ${version} of ${ref}` : `${ref} and all its versions`} ${version ? "was" : "were"} removed from the OTInstaller Registry.\n\n` +
      `Category: ${category}\nReason: ${reason}\n\nIt no longer installs, and people who have it installed are warned. ` +
      `You can appeal once by replying to this email.` + footer(env),
  }),
  reportReceived: (env: Env, ref: string, reason: string, details: string, id: string) => ({
    subject: `[${reason === "malware" ? "URGENT malware" : "report"}] ${ref}`,
    text: `A ${reason} report was filed against ${ref}:\n\n${details || "(no details)"}\n\nReview it: ${env.SITE_URL}/admin/reports#${id}` +
      (reason === "malware" ? "\n\nMalware reports have a 24-hour response target. With evidence, any reviewer can remove the version now." : ""),
  }),
  transferOffered: (env: Env, ref: string, from: string, to: string, id: string) => ({
    subject: `${from} offers ${ref} to ${to}`,
    text: `${from} wants to transfer ${ref} to your namespace ${to}. Its versions, stars and installs move with it, and the old address keeps working.\n\n` +
      `Accept or decline: ${env.SITE_URL}/transfers/${id}` + footer(env),
  }),
  transferCompleted: (env: Env, oldRef: string, newRef: string) => ({
    subject: `${oldRef} is now ${newRef}`,
    text: `${oldRef} moved to ${newRef}. Installs from the old address keep working and print the new name; the website redirects.` + footer(env),
  }),
  claimToReview: (env: Env, ref: string, to: string, id: string) => ({
    subject: `Claim of ${ref} by ${to} is verified`,
    text: `The upstream owner verified their claim of ${ref} for the namespace ${to}. Complete it: ${env.SITE_URL}/admin/transfers#${id}`,
  }),
  healthFailing: (env: Env, ref: string, version: string, excerpt: string) => ({
    subject: `${ref} ${version} failed its health check`,
    text: `Tonight's health check ran ${ref} ${version} with its test input and it failed:\n\n${excerpt || "(no output)"}\n\n` +
      `After 3 failures in a row the tool is marked Possibly broken in search. One passing run clears it. Usually a site the tool queries changed; ` +
      `publish a fixed version when you can. You get this email once per run of failures.` + footer(env),
  }),
  stuckJobs: (env: Env, jobs: { id: string; repo: string; tag: string; status: string; age_min: number }[]) => ({
    subject: `${jobs.length} publish job(s) stuck for over 30 minutes`,
    text: jobs.map((j) => `${j.repo} ${j.tag}: ${j.status} for ${j.age_min} min (job ${j.id})`).join("\n") + `\n\n${env.SITE_URL}/admin`,
  }),
  dailyDigest: (env: Env, waiting: { name: string; days: number }[], reports: { ref: string; reason: string; hours: number }[]) => ({
    subject: `Review digest: ${waiting.length} namespace(s) waiting, ${reports.length} old report(s)`,
    text: [
      waiting.length ? `Namespaces waiting more than 2 business days:\n${waiting.map((w) => `  ${w.name} (${w.days} days)`).join("\n")}` : "",
      reports.length ? `Reports open more than 48 hours:\n${reports.map((r) => `  ${r.ref}: ${r.reason} (${r.hours} h)`).join("\n")}` : "",
      `${env.SITE_URL}/admin`,
    ].filter(Boolean).join("\n\n"),
  }),
  backupTooLarge: (env: Env, ref: string, items: { kind: string; size_bytes: number | null }[]) => ({
    subject: `Part of ${ref} is too large to back up`,
    text: `The registry keeps backup copies of every package so installs keep working if its host removes it by mistake. ` +
      `These were over the limit and are not backed up:\n\n` +
      items.map((i) => `  ${i.kind === "git" ? "git repository bundle (limit 500 MB)" : i.kind === "image" ? "container image (limit 2 GB)" : i.kind}` +
        `${i.size_bytes ? `: ${Math.round(i.size_bytes / 1024 ** 2)} MB` : ""}`).join("\n") +
      `\n\nEverything else is backed up as usual${items.some((i) => i.kind === "git") ? " (an artifact-only backup)" : ""}. ` +
      `To get under the limit, move large files out of the repository's history or slim the image.` + footer(env),
  }),
  drillFailed: (env: Env, id: string, status: string, detail: string) => ({
    subject: `Restore drill ${status === "expired" ? "did not report back" : "failed"}`,
    text: `This month's restore drill (${id}) ${status === "expired" ? "did not report back" : "failed"}:\n\n${detail || "(no detail)"}\n\n` +
      `Check the drill run in registry-ops (Actions → scan) and the backups bucket. ${env.SITE_URL}/admin`,
  }),
  namespaceRejected: (env: Env, ns: string, reason: string) => ({
    subject: `${ns} was not approved`,
    text: `Your namespace ${ns} was not approved for the OTInstaller Registry.\n\nReason: ${reason}\n\nYou can appeal once by replying to this email.` + footer(env),
  }),
};
