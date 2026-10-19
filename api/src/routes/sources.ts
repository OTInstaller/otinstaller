// Connecting GitLab projects, and the sync controls owners see on the dashboard.
import type { Context } from "hono";
import { deps, type App, type AppEnv, type Env } from "../env";
import { apiError } from "../lib/errors";
import { randomToken, sha256Hex, ulid } from "../lib/crypto";
import * as gitlab from "../hosts/gitlab";
import { HostError } from "../hosts/github";
import { gitlabToken, type SourceRow } from "../hosts/repo";
import { audit, requireUser } from "./auth";
import { pollSource, RELEASE_TAG, sourceById, SOURCE_COLUMNS } from "../sync";

const MANUAL_SYNC_PER_HOUR = 10;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The namespace a GitLab user or group publishes into: the existing one, or the name it would get. */
export async function gitlabNamespaceName(env: Env, ns: gitlab.GitlabProject["namespace"]): Promise<{ id?: string; name: string; status: string }> {
  const existing = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE provider = 'gitlab' AND provider_owner_id = ?`)
    .bind(String(ns.id)).first<{ id: string; name: string; status: string }>();
  if (existing) return existing;
  let name = slug(ns.path);
  if (await env.DB.prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(name).first()) name = `${name.slice(0, 37)}-gl`;
  return { name, status: "pending_review" };
}

/** Finds (or creates, awaiting review) the namespace for a GitLab user or group. */
async function gitlabNamespace(env: Env, ns: gitlab.GitlabProject["namespace"]): Promise<{ id: string; name: string; status: string }> {
  const found = await gitlabNamespaceName(env, ns);
  if (found.id) return found as { id: string; name: string; status: string };
  const id = ulid();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, display_name, status, created_at) VALUES (?, 'gitlab', ?, ?, ?, ?, 'pending_review', ?)`,
    ).bind(id, String(ns.id), found.name, ns.kind === "group" ? "group" : "user", ns.full_path, Date.now()),
    audit(env.DB, null, "gitlab", "namespace.create", "namespace", id, { path: ns.full_path }),
  ]);
  return { id, name: found.name, status: "pending_review" };
}

/**
 * Connects a public GitLab project the user maintains: its namespace, the user's membership, the project
 * webhook and the source row. A registry-held manifest is stored on the source when one is given.
 */
export async function connectGitlabProject(env: Env, userId: string, token: string, p: gitlab.GitlabProject, registryManifest?: string) {
  const existing = await env.DB.prepare(`SELECT id, connected_by FROM sources WHERE provider = 'gitlab' AND project_id = ?`)
    .bind(String(p.id)).first<{ id: string; connected_by: string }>();
  if (existing && existing.connected_by !== userId) apiError(409, "already_connected", "someone else already connected this project");

  const ns = await gitlabNamespace(env, p.namespace);
  const role = p.namespace.kind === "user" || gitlab.accessLevel(p) >= gitlab.OWNER ? "owner" : "publisher";
  const secret = randomToken(32);
  let hookId: string;
  try {
    hookId = await gitlab.createHook(deps.fetch, token, p.id, `${env.API_URL}/v1/webhooks/gitlab`, secret, p.default_branch);
  } catch (e) {
    if (e instanceof HostError && e.status === 403) {
      apiError(403, "gitlab_scope_required", "connecting a project needs permission to create its webhook",
        `sign in again at ${env.API_URL}/v1/auth/gitlab/login?scope=api`);
    }
    throw e;
  }
  const id = existing?.id ?? ulid();
  const mode = registryManifest ? "registry" : "repo";
  // Tags that exist now predate the manifest; sync leaves them alone. If this fails, the first poll records them.
  const baseline = await gitlab.listTags(deps.fetch, token, String(p.id))
    .then((tags) => JSON.stringify(tags.filter((t) => RELEASE_TAG.test(t)))).catch(() => null);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sources (id, namespace_id, provider, project_id, path, url, default_branch, connected_by, webhook_id, webhook_secret_hash, visibility,
         manifest_mode, registry_manifest_json, baseline_tags, created_at)
       VALUES (?, ?, 'gitlab', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, project_id) DO UPDATE SET webhook_id = excluded.webhook_id, webhook_secret_hash = excluded.webhook_secret_hash,
         sync_status = 'ok', last_error = NULL, path = excluded.path, url = excluded.url,
         manifest_mode = CASE WHEN excluded.manifest_mode = 'registry' THEN 'registry' ELSE sources.manifest_mode END,
         registry_manifest_json = COALESCE(excluded.registry_manifest_json, sources.registry_manifest_json),
         baseline_tags = CASE WHEN sources.tool_id IS NULL THEN COALESCE(sources.baseline_tags, excluded.baseline_tags) ELSE sources.baseline_tags END`,
    ).bind(id, ns.id, String(p.id), p.path_with_namespace, p.web_url, p.default_branch, userId, hookId, await sha256Hex(secret), p.visibility,
      mode, registryManifest ?? null, baseline, Date.now()),
    env.DB.prepare(`INSERT OR IGNORE INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, ?)`).bind(ns.id, userId, role),
    audit(env.DB, userId, "user", "source.connect", "source", id, { project: p.path_with_namespace, manifest_mode: mode }),
  ]);
  return { sourceId: id, namespace: ns.name, namespaceStatus: ns.status, role };
}

/** The signed-in user must belong to the namespace that owns the source. */
export async function requireMember(c: Context<AppEnv>, namespaceId: string | null) {
  const u = requireUser(c);
  const m = namespaceId
    ? await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(namespaceId, u.id).first<{ role: string }>()
    : null;
  if (!m && !u.is_admin) apiError(403, "forbidden", "only the package's owners can do this");
  return u;
}

export async function sourceForPackage(env: Env, ns: string, name: string) {
  const s = await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM sources s JOIN tools t ON t.id = s.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
  ).bind(ns, name).first<SourceRow>();
  if (!s) apiError(404, "source_not_found", `${ns}/${name} has no connected source repository`);
  return s;
}

export function sourceRoutes(app: App) {
  app.post("/sources/gitlab", async (c) => {
    const u = requireUser(c);
    const { project } = await c.req.json<{ project?: string }>().catch(() => ({} as { project?: string }));
    if (!project?.trim()) apiError(400, "invalid_body", "send {project: 'group/name'}");
    let token: string;
    try {
      token = await gitlabToken(c.env, u.id);
    } catch {
      apiError(400, "gitlab_not_linked", "link your GitLab account first", "sign in with GitLab from Settings");
    }
    const path = project.trim().replace(/^https?:\/\/gitlab\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    const p = await gitlab.getProject(deps.fetch, token, path);
    if (!p) apiError(404, "project_not_found", "that project does not exist or you cannot see it");
    if (gitlab.accessLevel(p) < gitlab.MAINTAINER) apiError(403, "not_maintainer", "you need Maintainer access or above to connect a project");
    if (p.visibility !== "public") apiError(400, "project_not_public", "only public projects can publish to the registry");

    const r = await connectGitlabProject(c.env, u.id, token, p);
    return c.json({ source_id: r.sourceId, project: p.path_with_namespace, namespace: r.namespace, namespace_status: r.namespaceStatus, role: r.role }, 201);
  });

  app.delete("/sources/:id", async (c) => {
    const s = await sourceById(c.env, c.req.param("id"));
    if (!s) apiError(404, "source_not_found", "no such source");
    const u = await requireMember(c, s.namespace_id);
    const hook = await c.env.DB.prepare(`SELECT webhook_id FROM sources WHERE id = ?`).bind(s.id).first<{ webhook_id: string | null }>();
    if (s.provider === "gitlab" && hook?.webhook_id && s.connected_by) {
      try {
        await gitlab.deleteHook(deps.fetch, await gitlabToken(c.env, s.connected_by), s.project_id, hook.webhook_id);
      } catch {
        // The webhook may already be gone; disconnecting still succeeds.
      }
    }
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE sources SET sync_status = 'paused', webhook_id = NULL, webhook_secret_hash = NULL, last_error = 'disconnected' WHERE id = ?`).bind(s.id),
      audit(c.env.DB, u.id, "user", "source.disconnect", "source", s.id),
    ]);
    return c.body(null, 204);
  });

  app.post("/packages/:ns/:name/sync", async (c) => {
    const s = await sourceForPackage(c.env, c.req.param("ns"), c.req.param("name"));
    await requireMember(c, s.namespace_id);
    const recent = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sync_events WHERE source_id = ? AND kind = 'manual' AND received_at > ?`)
      .bind(s.id, Date.now() - 3600_000).first<{ n: number }>();
    if ((recent?.n ?? 0) >= MANUAL_SYNC_PER_HOUR) apiError(429, "sync_rate_limited", `at most ${MANUAL_SYNC_PER_HOUR} manual syncs per hour`);
    return c.json(await pollSource(c.env, s, "manual"));
  });

  app.get("/packages/:ns/:name/sync-log", async (c) => {
    const s = await sourceForPackage(c.env, c.req.param("ns"), c.req.param("name"));
    await requireMember(c, s.namespace_id);
    const info = await c.env.DB.prepare(
      `SELECT provider, path, url, sync_status, last_error, last_event_at, last_poll_at, manifest_mode FROM sources WHERE id = ?`,
    ).bind(s.id).first();
    const events = await c.env.DB.prepare(
      `SELECT kind, payload_summary AS summary, status, error, received_at FROM sync_events WHERE source_id = ? ORDER BY received_at DESC LIMIT 50`,
    ).bind(s.id).all();
    return c.json({ source: info, events: events.results });
  });
}
