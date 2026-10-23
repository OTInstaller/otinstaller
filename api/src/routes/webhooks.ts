// GitHub App webhooks: installations become namespaces; tag pushes become publish jobs.
import { requireSecret, type App, type Env } from "../env";
import { apiError } from "../lib/errors";
import { hmacSha256Hex, safeEqual, sha256Hex, ulid } from "../lib/crypto";
import { audit } from "./auth";
import { githubRepo, gitlabRepo, type RepoMeta } from "../hosts/repo";
import { RELEASE_TAG, applyMeta, queueTag, recordEvent, refreshReadme, setChangelog, sourceByProject } from "../sync";
import { RESERVED_NAMESPACES } from "../lib/reserved";

const MAX_BODY = 5 * 1024 * 1024;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Creates (or finds) the namespace for a GitHub account. A new namespace waits for manual review.
 * If the account's login is already taken by someone on another host, or is one of the site's own sections
 * (RESERVED_NAMESPACES), it gets a "-gh" suffix.
 */
async function namespaceFor(env: Env, account: { id: number; login: string; type: string }): Promise<string> {
  const db = env.DB;
  const existing = await db.prepare(`SELECT id FROM namespaces WHERE provider = 'github' AND provider_owner_id = ?`).bind(String(account.id)).first<{ id: string }>();
  if (existing) return existing.id;
  let name = slug(account.login);
  if (RESERVED_NAMESPACES.has(name) || (await db.prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(name).first())) name = `${name.slice(0, 37)}-gh`;
  const id = ulid();
  await db.batch([
    db.prepare(
      `INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, display_name, status, created_at) VALUES (?, 'github', ?, ?, ?, ?, 'pending_review', ?)`,
    ).bind(id, String(account.id), name, account.type === "Organization" ? "org" : "user", account.login, Date.now()),
    audit(db, null, "github", "namespace.create", "namespace", id, { login: account.login }),
  ]);
  // The publisher page starts from the account's public GitHub profile.
  await env.PUBLISH_QUEUE.send({ profileNamespaceId: id });
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
    `SELECT namespace_id, repo_ids, repository_selection, suspended_at FROM installations WHERE github_installation_id = ?`,
  ).bind(p.installation?.id ?? -1).first<{ namespace_id: string; repo_ids: string; repository_selection: string; suspended_at: number | null }>();
  if (!inst || inst.suspended_at) return { status: "ignored: app not installed" };
  const repoId = String(p.repository.id);
  if (inst.repository_selection !== "all" && !JSON.parse(inst.repo_ids).includes(repoId)) return { status: "ignored: repository not connected" };
  // The repository's CI may have uploaded this release already (trusted publishing); a second job would only fail.
  const uploaded = await env.DB.prepare(
    `SELECT 1 FROM publish_jobs WHERE provider = 'github' AND repo_id = ? AND tag = ? AND namespace_id = ? AND bundle_key IS NOT NULL
       AND status IN ('queued', 'validating', 'scanning', 'awaiting_review', 'published') LIMIT 1`,
  ).bind(repoId, tag, inst.namespace_id).first();
  if (uploaded) return { status: "ignored: uploaded by the repository's CI" };

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

/** Repository state as GitHub sends it in webhook payloads. */
function githubMeta(r: Payload): RepoMeta {
  return {
    path: r.full_name, url: r.html_url, defaultBranch: r.default_branch ?? null, description: r.description ?? null,
    topics: r.topics ?? [], stars: r.stargazers_count ?? 0, archived: !!r.archived, visibility: r.private ? "private" : "public",
  };
}

/** push, release and repository events keep an already-published package in sync. */
async function onGithubSync(env: Env, event: string, delivery: string, p: Payload): Promise<string> {
  const s = p.repository ? await sourceByProject(env, "github", String(p.repository.id)) : null;
  if (!s) return "ignored: not a registry source";
  if (!(await recordEvent(env, s.id, delivery, event === "repository" ? "repo" : event, `${event}.${p.action ?? p.ref ?? ""}`))) return "duplicate delivery";
  await env.DB.prepare(`UPDATE sources SET last_event_at = ? WHERE id = ?`).bind(Date.now(), s.id).run();
  if (event === "repository") {
    return applyMeta(env, s, p.action === "deleted" ? null : githubMeta(p.repository));
  }
  if (event === "release" && ["published", "edited"].includes(p.action)) {
    await setChangelog(env, s, p.release.tag_name, p.release.body ?? "");
    return "changelog updated";
  }
  if (event === "push" && p.ref === `refs/heads/${p.repository.default_branch}` && s.installation_id) {
    await applyMeta(env, s, githubMeta(p.repository));
    await refreshReadme(env, s, githubRepo(env, s.installation_id, p.repository.full_name, String(p.repository.id)), p.repository.default_branch);
    return "metadata refreshed";
  }
  return "ignored";
}

/**
 * Org changes (renames, public members joining or leaving) refresh the publisher profile of the namespace bound to the
 * org. The GitHub App must subscribe to Organization events (and have Members: read) for GitHub to send them.
 */
async function onOrganization(env: Env, p: Payload): Promise<string> {
  const orgId = p.organization?.id;
  if (!orgId) return "ignored: no organization";
  const rows = await env.DB.prepare(
    `SELECT id FROM namespaces WHERE provider = 'github' AND provider_owner_id = ?1
     UNION SELECT namespace_id FROM namespace_hosts WHERE provider = 'github' AND provider_owner_id = ?1`,
  ).bind(String(orgId)).all<{ id: string }>();
  for (const r of rows.results) await env.PUBLISH_QUEUE.send({ profileNamespaceId: r.id });
  return rows.results.length ? "profile refresh queued" : "ignored: not a registry namespace";
}

async function onGitlab(env: Env, eventId: string, p: Payload, token: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const projectId = String(p.project_id ?? p.project?.id ?? "");
  const s = projectId ? await sourceByProject(env, "gitlab", projectId) : null;
  const hash = s ? (await env.DB.prepare(`SELECT webhook_secret_hash FROM sources WHERE id = ?`).bind(s.id).first<{ webhook_secret_hash: string | null }>())?.webhook_secret_hash : null;
  // Each project has its own secret, so a leaked one cannot be used for another project.
  if (!s || !hash || !safeEqual(await sha256Hex(token), hash)) return { code: 401, body: { error: { code: "bad_signature", message: "webhook token does not match" } } };
  if (s.sync_status === "paused") return { code: 200, body: { status: "ignored: sync paused" } };
  const kind = p.object_kind === "tag_push" ? "tag" : p.object_kind === "release" ? "release" : p.object_kind === "push" ? "push" : "repo";
  if (!(await recordEvent(env, s.id, `gitlab:${eventId}`, kind, `${p.object_kind}:${p.ref ?? p.tag ?? ""}`))) return { code: 200, body: { status: "duplicate delivery" } };
  await env.DB.prepare(`UPDATE sources SET last_event_at = ? WHERE id = ?`).bind(Date.now(), s.id).run();
  const path: string = p.project?.path_with_namespace ?? s.path ?? "";
  switch (p.object_kind) {
    case "tag_push": {
      const tag = String(p.ref ?? "").replace(/^refs\/tags\//, "");
      if (/^0+$/.test(p.after ?? "")) return { code: 200, body: { status: "ignored: tag deleted" } };
      if (!RELEASE_TAG.test(tag)) return { code: 200, body: { status: "ignored: not a vX.Y.Z tag" } };
      const jobId = await queueTag(env, s, tag, `gitlab:${eventId}`, path);
      return { code: 202, body: jobId ? { status: "queued", jobId } : { status: "ignored: already handled" } };
    }
    case "release":
      if (["create", "update"].includes(p.action)) await setChangelog(env, s, p.tag, p.description ?? "");
      return { code: 200, body: { status: "changelog updated" } };
    case "push": {
      const branch = String(p.ref ?? "").replace(/^refs\/heads\//, "");
      if (branch === p.project?.default_branch && s.connected_by) {
        const host = gitlabRepo(env, s.project_id, s.connected_by);
        await applyMeta(env, s, await host.metadata());
        await refreshReadme(env, s, host, branch);
        return { code: 200, body: { status: "metadata refreshed" } };
      }
      return { code: 200, body: { status: "ignored: not the default branch" } };
    }
  }
  return { code: 200, body: { status: `ignored: ${p.object_kind}` } };
}

export function webhookRoutes(app: App) {
  app.post("/webhooks/gitlab", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_BODY) apiError(413, "payload_too_large", "webhook payload is larger than 5 MB");
    const body = await c.req.text();
    if (body.length > MAX_BODY) apiError(413, "payload_too_large", "webhook payload is larger than 5 MB");
    const p = JSON.parse(body) as Payload;
    const eventId = c.req.header("x-gitlab-event-uuid") ?? c.req.header("x-gitlab-webhook-uuid") ?? ulid();
    const out = await onGitlab(c.env, eventId, p, c.req.header("x-gitlab-token") ?? "");
    return c.json(out.body, out.code as 200);
  });

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
      case "organization":
      case "membership":
        return c.json({ status: await onOrganization(c.env, p) });
      case "push":
      case "release":
      case "repository":
        return c.json({ status: await onGithubSync(c.env, event, delivery, p) });
      default:
        return c.json({ status: `ignored: ${event}` });
    }
  });
}
