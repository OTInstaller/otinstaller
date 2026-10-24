// Trust and safety: yanking, deprecating and removing (and telling the people who follow the package), reports and
// their rate limits, and the public transparency numbers. Routes live in routes/trust.ts.
import type { Env } from "./env";
import { sha256Hex, ulid } from "./lib/crypto";
import type { Manifest } from "./lib/manifest";
import { latestMetadata, pickLatest } from "./scans";
import { audit } from "./routes/auth";
import { bumpCacheEpoch } from "./edge-cache";
import { ownerEmails, sendEmail, templates } from "./notify";
import { scheduleDeletion } from "./backups";
import { LIFECYCLE_LEVELS, notifyPackageFollowers, SECURITY_LEVELS } from "./inbox";

export const REPORT_REASONS = ["malware", "policy", "impersonation", "license", "broken", "other"] as const;
export const REMOVAL_CATEGORIES = ["malware", "policy", "impersonation", "license", "legal", "other"] as const;

export type ToolRef = {
  id: string;
  name: string;
  kind: string;
  status: string;
  namespace_id: string;
  namespace: string;
  namespace_status: string;
  community_packaged: number;
  latest_version_id: string | null;
};

/** A package by address, whatever its state (owners and reviewers act on unpublished ones too). */
export async function toolByRef(env: Env, ns: string, name: string): Promise<ToolRef | null> {
  return env.DB.prepare(
    `SELECT t.id, t.name, t.kind, t.status, t.namespace_id, n.name AS namespace, n.status AS namespace_status, t.community_packaged, t.latest_version_id
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
  ).bind(ns, name).first<ToolRef>();
}

/**
 * Points the tool at its highest published version (stable first) and refreshes the search metadata from it.
 * With nothing published left the tool leaves search but keeps its address.
 */
export async function recomputeLatest(env: Env, toolId: string): Promise<string | null> {
  const db = env.DB;
  const rows = (await db.prepare(
    `SELECT v.id, t.kind, v.semver_major, v.semver_minor, v.semver_patch, v.semver_pre, v.manifest_json
     FROM versions v JOIN tools t ON t.id = v.tool_id WHERE v.tool_id = ? AND v.status = 'published'`,
  ).bind(toolId).all<{ id: string; kind: string; semver_major: number; semver_minor: number; semver_patch: number; semver_pre: string; manifest_json: string }>()).results;
  const latest = pickLatest(rows);
  const stmts = [db.prepare(`UPDATE tools SET latest_version_id = ?, updated_at = ? WHERE id = ?`).bind(latest?.id ?? null, Date.now(), toolId)];
  if (latest) stmts.push(...latestMetadata(db, toolId, latest.kind, latest.id, JSON.parse(latest.manifest_json) as Manifest));
  await db.batch(stmts);
  return latest?.id ?? null;
}

/** Yank hides a version from search and @latest; it stays installable by exact version. */
export async function setYanked(env: Env, actorId: string, t: ToolRef, version: string, yanked: boolean) {
  const v = await env.DB.prepare(`SELECT id, status FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, version).first<{ id: string; status: string }>();
  const from = yanked ? "published" : "yanked";
  if (!v || v.status !== from) return { ok: false as const, status: v?.status ?? null };
  await env.DB.batch([
    env.DB.prepare(`UPDATE versions SET status = ?, yanked_at = ? WHERE id = ?`).bind(yanked ? "yanked" : "published", yanked ? Date.now() : null, v.id),
    audit(env.DB, actorId, "user", yanked ? "version.yank" : "version.unyank", "version", v.id, { ref: `${t.namespace}/${t.name}`, version }),
    // @latest moves at once instead of when cached answers run out.
    bumpCacheEpoch(env.DB),
  ]);
  await recomputeLatest(env, t.id);
  const ref = `${t.namespace}/${t.name}`;
  await notifyPackageFollowers(env, t.id, {
    kind: "lifecycle", scope: "lifecycle", actor_id: actorId, path: `/${ref}/versions`,
    summary: yanked ? `${ref} ${version} was yanked: @latest no longer installs it` : `${ref} ${version} is available again`,
  }, LIFECYCLE_LEVELS);
  return { ok: true as const, status: yanked ? "yanked" : "published" };
}

/** Marks a package deprecated, with a message and maybe its replacement; its followers hear about it once. */
export async function setDeprecated(env: Env, actorId: string, t: ToolRef, message: string, replacement: string | null) {
  const [r] = await env.DB.batch([
    env.DB.prepare(`UPDATE tools SET status = 'deprecated', deprecated_message = ?, deprecated_replacement = ? WHERE id = ? AND status != 'removed'`)
      .bind(message, replacement, t.id),
    audit(env.DB, actorId, "user", "tool.deprecate", "tool", t.id, { message, replacement }),
  ]);
  // Changing the message of a package that is already deprecated tells nobody again.
  if (t.status === "deprecated" || !r?.meta.changes) return;
  const ref = `${t.namespace}/${t.name}`;
  await notifyPackageFollowers(env, t.id, {
    kind: "lifecycle", scope: "lifecycle", actor_id: actorId, path: `/${ref}`,
    summary: `${ref} is deprecated${replacement ? `; use ${replacement} instead` : ""}: ${message}`,
  }, LIFECYCLE_LEVELS);
}

/** Takes the deprecation off a package; its followers hear about it when it was deprecated. */
export async function clearDeprecated(env: Env, actorId: string, t: ToolRef) {
  const [r] = await env.DB.batch([
    env.DB.prepare(`UPDATE tools SET status = 'active', deprecated_message = NULL, deprecated_replacement = NULL WHERE id = ? AND status = 'deprecated'`).bind(t.id),
    audit(env.DB, actorId, "user", "tool.undeprecate", "tool", t.id),
  ]);
  if (!r?.meta.changes) return;
  const ref = `${t.namespace}/${t.name}`;
  await notifyPackageFollowers(env, t.id, { kind: "lifecycle", scope: "lifecycle", actor_id: actorId, path: `/${ref}`, summary: `${ref} is no longer deprecated` }, LIFECYCLE_LEVELS);
}

/** How a takedown's category reads in a follower's notification (never the reviewer's reason, which can be private). */
const REMOVED_BECAUSE: Record<string, string> = {
  malware: "as malware", policy: "for breaking the registry's policies", impersonation: "for impersonation", license: "over its license", legal: "for legal reasons", other: "",
};

/** Tells a package's followers about a takedown: malware reaches everyone who hasn't muted it, as a security warning. */
async function notifyRemoval(env: Env, actorId: string, t: ToolRef, version: string | null, category: string) {
  const ref = `${t.namespace}/${t.name}`;
  const malware = category === "malware";
  const what = `${ref}${version ? ` ${version}` : ""} was taken down${REMOVED_BECAUSE[category] ? ` ${REMOVED_BECAUSE[category]}` : ""}`;
  await notifyPackageFollowers(env, t.id, {
    kind: malware ? "security" : "lifecycle", scope: malware ? "security" : "lifecycle", actor_id: actorId, path: `/${ref}`,
    summary: malware ? `${what}; uninstall it with \`ot uninstall ${ref}\`` : what,
  }, malware ? SECURITY_LEVELS : LIFECYCLE_LEVELS);
}

/** Removal is for malware and policy violations: the version stops resolving and is listed on the transparency page. */
export async function removeVersion(env: Env, actorId: string, t: ToolRef, version: string | null, category: string, reason: string, suspend: boolean) {
  const db = env.DB;
  const now = Date.now();
  const ref = `${t.namespace}/${t.name}`;
  const stmts: D1PreparedStatement[] = [];
  let versionId: string | null = null;
  if (version) {
    const v = await db.prepare(`SELECT id, status FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, version).first<{ id: string; status: string }>();
    if (!v || v.status === "rejected") return { ok: false as const, error: `${ref} has no version ${version}` };
    if (v.status === "removed") return { ok: false as const, error: `${ref} ${version} is already removed` };
    versionId = v.id;
    stmts.push(
      db.prepare(`UPDATE versions SET status = 'removed', removed_reason = ?, removed_category = ?, removed_at = ?, removed_by = ?, scan_token_hash = NULL WHERE id = ?`)
        .bind(reason, category, now, actorId, v.id),
      audit(db, actorId, "user", "version.remove", "version", v.id, { ref, version, category, reason }),
    );
  } else {
    if (t.status === "removed") return { ok: false as const, error: `${ref} is already removed` };
    stmts.push(
      db.prepare(`UPDATE versions SET status = 'removed', removed_reason = ?, removed_category = ?, removed_at = ?, removed_by = ?, scan_token_hash = NULL
                  WHERE tool_id = ? AND status NOT IN ('rejected', 'removed')`).bind(reason, category, now, actorId, t.id),
      db.prepare(`UPDATE tools SET status = 'removed', removed_reason = ?, removed_category = ?, removed_at = ? WHERE id = ?`).bind(reason, category, now, t.id),
      audit(db, actorId, "user", "tool.remove", "tool", t.id, { ref, category, reason }),
    );
  }
  if (suspend && t.namespace_status !== "suspended") {
    stmts.push(
      db.prepare(`UPDATE namespaces SET status = 'suspended', review_notes = ? WHERE id = ?`).bind(`Suspended pending investigation: ${reason}`, t.namespace_id),
      audit(db, actorId, "user", "namespace.suspend", "namespace", t.namespace_id, { reason, after: "removal" }),
    );
  }
  // Nothing cached before the takedown (manifests, wheel copies, /removed) is served again.
  stmts.push(bumpCacheEpoch(db, now));
  await db.batch(stmts);
  await recomputeLatest(env, t.id);
  // Takedowns apply to backups: the mirror stops serving them now, and they are deleted after 14 days.
  await scheduleDeletion(env, t.id, versionId, now);
  await sendEmail(env, { to: await ownerEmails(env, t.namespace_id), kind: "removed", key: `removed:${t.id}:${version ?? "all"}`, ...templates.removed(env, ref, version, category, reason) });
  await notifyRemoval(env, actorId, t, version, category);
  return { ok: true as const };
}

/** Counts a hit in a fixed window; true when the limit is exceeded. Keys are hashed with a server secret. */
export async function overLimit(env: Env, scope: string, who: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const key = (await sha256Hex(`${env.TOKEN_ENC_KEY ?? "ot"}|${scope}|${who}`)).slice(0, 32);
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(key, start).first<{ count: number }>();
  return (row?.count ?? 1) > limit;
}

export async function fileReport(env: Env, t: ToolRef, reporterId: string | null, reason: string, details: string, versionId: string | null) {
  const id = ulid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO reports (id, tool_id, version_id, reporter_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, t.id, versionId, reporterId, reason, details, Date.now()),
    audit(env.DB, reporterId, reporterId ? "user" : "system", "report.create", "tool", t.id, { report: id, reason }),
  ]);
  return id;
}

/** Removed packages and quarterly report and action counts, for /policy/transparency. */
export async function transparency(env: Env) {
  const removed = (await env.DB.prepare(
    `SELECT n.name AS namespace, t.name, v.version, v.removed_category AS category, v.removed_at
       FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE v.status = 'removed' AND v.removed_at IS NOT NULL AND t.status != 'removed'
     UNION ALL
     SELECT n.name, t.name, NULL, t.removed_category, t.removed_at
       FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE t.status = 'removed' AND t.removed_at IS NOT NULL
     ORDER BY removed_at DESC LIMIT 500`,
  ).all<{ namespace: string; name: string; version: string | null; category: string | null; removed_at: number }>()).results;
  const reports = (await env.DB.prepare(`SELECT created_at, status FROM reports`).all<{ created_at: number; status: string }>()).results;
  const quarter = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  };
  const q = new Map<string, { quarter: string; reports: number; actioned: number; dismissed: number; removals: number }>();
  const get = (k: string) => q.get(k) ?? (q.set(k, { quarter: k, reports: 0, actioned: 0, dismissed: 0, removals: 0 }), q.get(k)!);
  for (const r of reports) {
    const e = get(quarter(r.created_at));
    e.reports++;
    if (r.status === "actioned") e.actioned++;
    if (r.status === "dismissed") e.dismissed++;
  }
  for (const r of removed) get(quarter(r.removed_at)).removals++;
  return {
    removed: removed.map((r) => ({ ref: `${r.namespace}/${r.name}`, version: r.version, category: r.category ?? "other", removed_at: r.removed_at })),
    quarters: [...q.values()].sort((a, b) => b.quarter.localeCompare(a.quarter)),
  };
}
