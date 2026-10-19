// GitHub App webhooks: installations become namespaces; tag pushes become publish jobs.
import { requireSecret, type App, type Env } from "../env";
import { apiError } from "../lib/errors";
import { hmacSha256Hex, safeEqual, ulid } from "../lib/crypto";
import { audit } from "./auth";

const MAX_BODY = 5 * 1024 * 1024;
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Creates (or finds) the namespace for a GitHub account. A new namespace waits for manual review.
 * If the account's login is already taken by someone on another host, it gets a "-gh" suffix.
 */
async function namespaceFor(env: Env, account: { id: number; login: string; type: string }): Promise<string> {
  const db = env.DB;
  const existing = await db.prepare(`SELECT id FROM namespaces WHERE provider = 'github' AND provider_owner_id = ?`).bind(String(account.id)).first<{ id: string }>();
  if (existing) return existing.id;
  let name = slug(account.login);
  if (await db.prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(name).first()) name = `${name.slice(0, 37)}-gh`;
  const id = ulid();
  await db.batch([
    db.prepare(
      `INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, display_name, status, created_at) VALUES (?, 'github', ?, ?, ?, ?, 'pending_review', ?)`,
    ).bind(id, String(account.id), name, account.type === "Organization" ? "org" : "user", account.login, Date.now()),
    audit(db, null, "github", "namespace.create", "namespace", id, { login: account.login }),
  ]);
  return id;
}

async function addOwnerIfKnown(env: Env, namespaceId: string, senderId: number) {
  const acct = await env.DB.prepare(`SELECT user_id FROM accounts WHERE provider = 'github' AND provider_user_id = ?`).bind(String(senderId)).first<{ user_id: string }>();
  if (acct) {
    await env.DB.prepare(`INSERT OR IGNORE INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(namespaceId, acct.user_id).run();
  }
}

type Payload = Record<string, any>;

async function onInstallation(env: Env, action: string, p: Payload) {
  const inst = p.installation;
  const db = env.DB;
  if (action === "created" || action === "new_permissions_accepted" || action === "unsuspend") {
    const nsId = await namespaceFor(env, inst.account);
    const repoIds = JSON.stringify((p.repositories ?? []).map((r: any) => String(r.id)));
    await db.prepare(
      `INSERT INTO installations (id, github_installation_id, namespace_id, repo_ids, account_login, account_type, repository_selection, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (github_installation_id) DO UPDATE SET namespace_id = excluded.namespace_id, suspended_at = NULL,
         repository_selection = excluded.repository_selection,
         repo_ids = CASE WHEN excluded.repo_ids = '[]' THEN installations.repo_ids ELSE excluded.repo_ids END`,
    ).bind(ulid(), inst.id, nsId, repoIds, inst.account.login, inst.account.type, inst.repository_selection ?? "selected", Date.now()).run();
    await addOwnerIfKnown(env, nsId, p.sender.id);
  } else if (action === "deleted" || action === "suspend") {
    await db.prepare(`UPDATE installations SET suspended_at = ? WHERE github_installation_id = ?`).bind(Date.now(), inst.id).run();
  }
  await audit(db, null, "github", `installation.${action}`, "installation", String(inst.id), { account: inst.account.login }).run();
}

async function onInstallationRepositories(env: Env, p: Payload) {
  const row = await env.DB.prepare(`SELECT repo_ids FROM installations WHERE github_installation_id = ?`).bind(p.installation.id).first<{ repo_ids: string }>();
  if (!row) return;
  const ids = new Set<string>(JSON.parse(row.repo_ids));
  for (const r of p.repositories_added ?? []) ids.add(String(r.id));
  for (const r of p.repositories_removed ?? []) ids.delete(String(r.id));
  await env.DB.prepare(`UPDATE installations SET repo_ids = ?, repository_selection = ? WHERE github_installation_id = ?`)
    .bind(JSON.stringify([...ids]), p.repository_selection ?? "selected", p.installation.id).run();
}

async function onTag(env: Env, deliveryId: string, p: Payload): Promise<{ status: string; jobId?: string }> {
  const tag: string = p.ref;
  if (!RELEASE_TAG.test(tag)) return { status: "ignored: not a vX.Y.Z tag" };
  const inst = await env.DB.prepare(
    `SELECT repo_ids, repository_selection, suspended_at FROM installations WHERE github_installation_id = ?`,
  ).bind(p.installation?.id ?? -1).first<{ repo_ids: string; repository_selection: string; suspended_at: number | null }>();
  if (!inst || inst.suspended_at) return { status: "ignored: app not installed" };
  const repoId = String(p.repository.id);
  if (inst.repository_selection !== "all" && !JSON.parse(inst.repo_ids).includes(repoId)) return { status: "ignored: repository not connected" };

  const jobId = ulid();
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO publish_jobs (id, delivery_id, provider, repo, repo_id, tag, installation_id, status, created_at, updated_at)
     VALUES (?, ?, 'github', ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (delivery_id) DO NOTHING`,
  ).bind(jobId, deliveryId, p.repository.full_name, repoId, tag, p.installation.id, now, now).run();
  if (!r.meta.changes) return { status: "duplicate delivery" };
  await env.PUBLISH_QUEUE.send({ jobId });
  return { status: "queued", jobId };
}

export function webhookRoutes(app: App) {
  app.post("/webhooks/github", async (c) => {
    const secret = requireSecret(c.env, "GITHUB_WEBHOOK_SECRET");
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY) apiError(413, "payload_too_large", "webhook payload is larger than 5 MB");
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BODY) apiError(413, "payload_too_large", "webhook payload is larger than 5 MB");
    const sig = c.req.header("x-hub-signature-256") ?? "";
    if (!safeEqual(sig, `sha256=${await hmacSha256Hex(secret, body)}`)) apiError(401, "bad_signature", "webhook signature does not match");

    const event = c.req.header("x-github-event") ?? "";
    const delivery = c.req.header("x-github-delivery") ?? ulid();
    const p = JSON.parse(new TextDecoder().decode(body)) as Payload;
    switch (event) {
      case "ping":
        return c.json({ status: "pong" });
      case "installation":
        await onInstallation(c.env, p.action, p);
        return c.json({ status: "ok" });
      case "installation_repositories":
        await onInstallationRepositories(c.env, p);
        return c.json({ status: "ok" });
      case "create":
        if (p.ref_type !== "tag") return c.json({ status: "ignored: not a tag" });
        return c.json(await onTag(c.env, delivery, p), 202);
      default:
        return c.json({ status: `ignored: ${event}` });
    }
  });
}
