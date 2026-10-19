// Keeps packages in step with their source repositories: webhooks are the main signal, and a
// poll every 6 hours catches anything missed (tags, renames, archiving, deletion).
import type { Env } from "./env";
import { ulid } from "./lib/crypto";
import { HostError } from "./hosts/github";
import { hostForSource, repoUrl, type RepoHost, type RepoMeta, type SourceRow } from "./hosts/repo";
import { audit } from "./routes/auth";
import { ownerEmails, sendEmail } from "./notify";

export const POLL_INTERVAL = 6 * 3600 * 1000;
export const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ARCHIVED_MESSAGE = "The source repository was archived.";
const RESTORE_WINDOW = 30 * 24 * 3600 * 1000;
const MAX_TAGS_PER_POLL = 3;

export const SOURCE_COLUMNS = `s.id, s.tool_id, s.namespace_id, s.provider, s.project_id, s.path, s.url, s.installation_id, s.connected_by,
  s.etag, s.manifest_mode, s.baseline_tags, s.sync_status, s.archived, s.unavailable_since`;

export async function sourceById(env: Env, id: string) {
  return env.DB.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.id = ?`).bind(id).first<SourceRow>();
}

export async function sourceByProject(env: Env, provider: string, projectId: string) {
  return env.DB.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.provider = ? AND s.project_id = ?`).bind(provider, projectId).first<SourceRow>();
}

/** Records a sync event; returns false when this delivery was already seen. */
export async function recordEvent(env: Env, sourceId: string, eventId: string, kind: string, summary: string, status = "ok", error?: string) {
  const r = await env.DB.prepare(
    `INSERT INTO sync_events (id, source_id, provider_event_id, kind, payload_summary, status, error, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider_event_id) DO NOTHING`,
  ).bind(ulid(), sourceId, eventId, kind, summary.slice(0, 300), status, error ?? null, Date.now()).run();
  return r.meta.changes > 0;
}

async function notifyOwners(env: Env, s: SourceRow, kind: string, subject: string, text: string) {
  if (!s.namespace_id) return;
  await sendEmail(env, { to: await ownerEmails(env, s.namespace_id), kind, key: `${kind}:${s.id}:${new Date().toISOString().slice(0, 10)}`, subject,
    text: `${text}\n\n--\nOTInstaller Registry · ${env.SITE_URL}/dashboard` });
}

const owner = (path: string | null) => (path ?? "").split("/").slice(0, -1).join("/").toLowerCase();

/** Applies a repository's current state: gone, private, archived, renamed or transferred. */
export async function applyMeta(env: Env, s: SourceRow, meta: RepoMeta | null): Promise<string> {
  const db = env.DB;
  const now = Date.now();
  if (!meta || meta.visibility !== "public") {
    if (s.sync_status !== "unavailable") {
      await db.batch([
        db.prepare(`UPDATE sources SET sync_status = 'unavailable', unavailable_since = ?, last_error = ? WHERE id = ?`)
          .bind(now, meta ? "repository is no longer public" : "repository was deleted or is no longer accessible", s.id),
        audit(db, null, "system", "source.unavailable", "source", s.id),
      ]);
      await notifyOwners(env, s, "source_unavailable", `Your source repository is unavailable`,
        `${s.url} is ${meta ? "no longer public" : "gone or no longer accessible"}. The package is hidden from search and new versions are paused. ` +
        `Restore the repository within 30 days and the package comes back automatically.`);
    }
    return "unavailable";
  }

  const stmts: D1PreparedStatement[] = [];
  let result = "ok";
  if (s.sync_status === "unavailable") {
    if (s.unavailable_since && now - s.unavailable_since > RESTORE_WINDOW) return "unavailable";
    stmts.push(audit(db, null, "system", "source.restored", "source", s.id));
  }
  // A new owner has to confirm before the package follows the repository to them.
  if (s.path && owner(meta.path) !== owner(s.path)) {
    stmts.push(
      db.prepare(`UPDATE sources SET sync_status = 'transfer_pending', last_error = ? WHERE id = ?`).bind(`moved from ${s.path} to ${meta.path}; the new owner must confirm`, s.id),
      audit(db, null, "system", "source.transfer_detected", "source", s.id, { from: s.path, to: meta.path }),
    );
    await db.batch(stmts);
    return "transfer_pending";
  }
  const url = repoUrl(s.provider, meta.path);
  stmts.push(db.prepare(
    `UPDATE sources SET path = ?, url = ?, default_branch = ?, description = ?, topics = ?, stars = ?, archived = ?, visibility = ?,
       sync_status = 'ok', unavailable_since = NULL, last_error = NULL WHERE id = ?`,
  ).bind(meta.path, url, meta.defaultBranch, meta.description, JSON.stringify(meta.topics), meta.stars, meta.archived ? 1 : 0, meta.visibility, s.id));
  if (s.tool_id) {
    stmts.push(db.prepare(`UPDATE tools SET repo_url = ? WHERE id = ?`).bind(url, s.tool_id));
    if (meta.archived && !s.archived) {
      stmts.push(
        db.prepare(`UPDATE tools SET status = 'deprecated', deprecated_message = ? WHERE id = ? AND status = 'active'`).bind(ARCHIVED_MESSAGE, s.tool_id),
        audit(db, null, "system", "tool.deprecated_archived", "tool", s.tool_id),
      );
      result = "archived";
    } else if (!meta.archived && s.archived) {
      stmts.push(db.prepare(`UPDATE tools SET status = 'active', deprecated_message = NULL WHERE id = ? AND status = 'deprecated' AND deprecated_message = ?`).bind(s.tool_id, ARCHIVED_MESSAGE));
      result = "unarchived";
    }
  }
  await db.batch(stmts);
  if (result === "archived") {
    await notifyOwners(env, s, "source_archived", "Your package was marked deprecated",
      `${meta.path} was archived, so its package is now marked deprecated. Unarchive the repository to undo this.`);
  }
  return result;
}

/** Refreshes the README text search uses, from the default branch. Published versions never change. */
export async function refreshReadme(env: Env, s: SourceRow, host: RepoHost, branch: string | null) {
  if (!s.tool_id || !branch) return;
  const t = await env.DB.prepare(`SELECT v.manifest_json FROM tools t JOIN versions v ON v.id = t.latest_version_id WHERE t.id = ?`).bind(s.tool_id).first<{ manifest_json: string }>();
  const path = (t ? (JSON.parse(t.manifest_json).readme as string | undefined) : undefined) ?? "README.md";
  const text = await host.fileAt(path, branch);
  if (text !== null) await env.DB.prepare(`UPDATE tools SET readme_text = ? WHERE id = ?`).bind(text.slice(0, 20000), s.tool_id).run();
}

/** Creates (and queues) a publish job for a release tag, unless one exists already. */
export async function queueTag(env: Env, s: SourceRow, tag: string, deliveryId: string, path: string): Promise<string | null> {
  if (!RELEASE_TAG.test(tag)) return null;
  const known = await env.DB.prepare(
    `SELECT 1 FROM publish_jobs WHERE provider = ? AND repo_id = ? AND tag = ? AND status NOT IN ('error')
     UNION SELECT 1 FROM versions WHERE tool_id = ? AND version = ? AND status != 'rejected'`,
  ).bind(s.provider, s.project_id, tag, s.tool_id ?? "", tag.slice(1)).first();
  if (known) return null;
  const jobId = ulid();
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO publish_jobs (id, delivery_id, provider, repo, repo_id, tag, installation_id, source_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (delivery_id) DO NOTHING`,
  ).bind(jobId, deliveryId, s.provider, path, s.project_id, tag, s.installation_id, s.id, now, now).run();
  if (!r.meta.changes) return null;
  await env.PUBLISH_QUEUE.send({ jobId });
  return jobId;
}

export async function setChangelog(env: Env, s: SourceRow, tag: string, notes: string) {
  if (!s.tool_id || !RELEASE_TAG.test(tag)) return;
  await env.DB.prepare(`UPDATE versions SET changelog = ? WHERE tool_id = ? AND version = ?`).bind(notes.slice(0, 20000), s.tool_id, tag.slice(1)).run();
}

/** One sync pass over a source: metadata, README, then any release tags the webhooks missed. */
export async function pollSource(env: Env, s: SourceRow, kind: "poll" | "manual"): Promise<{ status: string; queued: string[] }> {
  const now = Date.now();
  const queued: string[] = [];
  try {
    const host = hostForSource(env, s);
    const meta = await host.metadata();
    const state = await applyMeta(env, s, meta);
    if (meta && (state === "ok" || state === "archived" || state === "unarchived")) {
      await refreshReadme(env, s, host, meta.defaultBranch);
      // A repo-mode source connected before its first release starts from the tags it already has:
      // those predate otinstaller.yaml, so only tags pushed after that are backfilled.
      const needsBaseline = !s.tool_id && s.manifest_mode === "repo" && s.baseline_tags === null;
      const tags = await host.listTags(needsBaseline ? null : s.etag);
      if (needsBaseline) {
        await env.DB.prepare(`UPDATE sources SET baseline_tags = ?, etag = ? WHERE id = ? AND baseline_tags IS NULL`)
          .bind(JSON.stringify(tags.tags.filter((t) => RELEASE_TAG.test(t))), tags.etag, s.id).run();
      } else if (!tags.notModified) {
        const baseline = new Set<string>(s.manifest_mode === "repo" && s.baseline_tags ? JSON.parse(s.baseline_tags) : []);
        const releases = tags.tags.filter((t) => RELEASE_TAG.test(t) && !baseline.has(t)).slice(0, 10);
        for (const tag of releases) {
          if (queued.length >= MAX_TAGS_PER_POLL) break;
          const id = await queueTag(env, s, tag, `${kind}:${s.provider}:${s.project_id}:${tag}`, meta.path);
          if (id) queued.push(tag);
        }
        // Keep the old ETag while tags are still waiting, so the next poll sees the list again.
        if (queued.length < MAX_TAGS_PER_POLL) await env.DB.prepare(`UPDATE sources SET etag = ? WHERE id = ?`).bind(tags.etag, s.id).run();
      }
    }
    await env.DB.prepare(`UPDATE sources SET last_poll_at = ? WHERE id = ?`).bind(now, s.id).run();
    await recordEvent(env, s.id, `${kind}:${s.id}:${now}`, kind, queued.length ? `queued ${queued.join(", ")}` : state);
    return { status: state, queued };
  } catch (e) {
    const err = e as Error;
    // Lost access (app uninstalled, token revoked) pauses sync until the owner reconnects.
    const lostAccess = e instanceof HostError && !e.transient && (e.status === 401 || e.status === 403);
    await env.DB.prepare(`UPDATE sources SET last_poll_at = ?, sync_status = ?, last_error = ? WHERE id = ?`)
      .bind(now, lostAccess ? "paused" : "error", err.message.slice(0, 500), s.id).run();
    await recordEvent(env, s.id, `${kind}:${s.id}:${now}`, kind, "failed", "error", err.message);
    if (lostAccess && s.sync_status !== "paused") {
      await notifyOwners(env, s, "sync_paused", "Sync paused for your package",
        `The registry lost access to ${s.url} (${err.message}). Your package stays published, but new versions won't arrive until you reconnect.`);
    }
    return { status: lostAccess ? "paused" : "error", queued };
  }
}

/** Cron: poll the sources that are due, oldest first. */
export async function pollDueSources(env: Env, now = Date.now(), limit = 50) {
  const due = await env.DB.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.sync_status IN ('ok', 'error', 'unavailable') AND (s.last_poll_at IS NULL OR s.last_poll_at < ?)
     ORDER BY s.last_poll_at IS NOT NULL, s.last_poll_at LIMIT ?`,
  ).bind(now - POLL_INTERVAL, limit).all<SourceRow>();
  for (const s of due.results) await pollSource(env, s, "poll");
  return due.results.length;
}
