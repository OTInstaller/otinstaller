// Queries shared by the public read endpoints: what is visible, how a package is summarised, and
// looking packages and versions up by address.
import { apiError } from "./lib/errors";
import type { RankInput } from "./ranking";

export function cached(c: { header: (k: string, v: string) => void }, seconds: number) {
  c.header("Cache-Control", `public, max-age=${seconds}`);
}

// A tool is visible when its namespace is active, it is not removed and it has a published version.
export const VISIBLE = `
  t.status != 'removed' AND n.status = 'active' AND t.latest_version_id IS NOT NULL`;

export const LISTED = `NOT EXISTS (SELECT 1 FROM sources s WHERE s.tool_id = t.id AND s.sync_status = 'unavailable')`;

export const SUMMARY_COLUMNS = `
  t.id, t.rowid AS rowid, n.name AS namespace, t.name, t.kind, t.summary, t.categories, t.status,
  t.stars_count, t.installs_30d, t.health_status, t.community_packaged, t.needs_update, n.verified,
  v.version AS latest_version, v.runtime_kind, v.signer_identity,
  json_extract(v.manifest_json, '$.title') AS title, json_extract(v.manifest_json, '$.level') AS level,
  json_extract(v.manifest_json, '$.format') AS format, json_extract(v.manifest_json, '$.language') AS language,
  (SELECT s.manifest_mode FROM sources s WHERE s.tool_id = t.id) AS manifest_mode,
  (SELECT s.sync_status FROM sources s WHERE s.tool_id = t.id) AS source_status,
  (SELECT group_concat(type) FROM tool_io WHERE tool_id = t.id AND direction = 'in') AS inputs,
  (SELECT group_concat(type) FROM tool_io WHERE tool_id = t.id AND direction = 'out') AS outputs,
  EXISTS (SELECT 1 FROM tool_secrets WHERE tool_id = t.id AND required = 1) AS needs_keys`;

export type SummaryRow = {
  id: string;
  rowid: number;
  namespace: string;
  name: string;
  kind: string;
  summary: string;
  categories: string;
  status: string;
  stars_count: number;
  installs_30d: number;
  health_status: string;
  community_packaged: number;
  needs_update: number;
  verified: number;
  latest_version: string;
  runtime_kind: string | null;
  signer_identity: string | null;
  title: string | null;
  level: string | null;
  format: string | null;
  language: string | null;
  manifest_mode: string | null;
  source_status: string | null;
  inputs: string | null;
  outputs: string | null;
  needs_keys: number;
};

export function summary(r: SummaryRow) {
  const guide = r.kind === "guide";
  return {
    namespace: r.namespace,
    name: r.name,
    kind: r.kind,
    summary: r.summary,
    latest_version: r.latest_version,
    categories: JSON.parse(r.categories) as string[],
    inputs: r.inputs ? r.inputs.split(",").sort() : [],
    outputs: r.outputs ? r.outputs.split(",").sort() : [],
    runtime: r.runtime_kind,
    stars: r.stars_count,
    installs_30d: r.installs_30d,
    health: r.health_status,
    verified: r.verified === 1,
    // Registry-held manifests never get the Signed badge.
    signed: !!r.signer_identity && r.manifest_mode !== "registry",
    needs_keys: r.needs_keys === 1,
    manifest_held_by_registry: r.manifest_mode === "registry",
    community_packaged: r.community_packaged === 1,
    source_unavailable: r.source_status === "unavailable",
    status: r.status,
    // Guides only: what the site shows on a guide card.
    ...(guide ? { title: r.title, level: r.level, format: r.format, language: r.language ?? "en", needs_update: r.needs_update === 1 } : {}),
  };
}

export function rankInput(r: SummaryRow, bm25?: number): RankInput {
  return {
    bm25,
    installs30d: r.installs_30d,
    stars: r.stars_count,
    healthy: r.health_status === "healthy",
    broken: r.health_status === "broken",
    verified: r.verified === 1,
    manifestHeld: r.manifest_mode === "registry",
  };
}

export type ToolRow = SummaryRow & {
  repo_url: string | null;
  deprecated_message: string | null;
  manifest_json: string;
  namespace_status: string;
  latest_version_id: string;
  dead_link_ratio: number | null;
  deprecated_replacement: string | null;
};

export async function findTool(db: D1Database, ns: string, name: string): Promise<{ row: ToolRow | null; movedTo?: string }> {
  const sql = `SELECT ${SUMMARY_COLUMNS}, t.repo_url, t.deprecated_message, t.deprecated_replacement, t.latest_version_id, t.dead_link_ratio, v.manifest_json, n.status AS namespace_status
    FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
    WHERE n.name = ? AND t.name = ? AND ${VISIBLE}`;
  const row = await db.prepare(sql).bind(ns, name).first<ToolRow>();
  if (row) return { row };
  // Transferred packages keep working at their old address.
  const alias = await db
    .prepare(
      `SELECT n.name AS ns, t.name AS name FROM aliases a JOIN tools t ON t.id = a.tool_id
       JOIN namespaces n ON n.id = t.namespace_id WHERE a.old_namespace = ? AND a.old_name = ?`,
    )
    .bind(ns, name)
    .first<{ ns: string; name: string }>();
  if (alias) {
    const moved = await findTool(db, alias.ns, alias.name);
    return { row: moved.row, movedTo: `${alias.ns}/${alias.name}` };
  }
  return { row: null };
}

/** Not found: removed packages answer 410 with why, so the CLI and site can say so instead of "not found". */
export async function notFound(db: D1Database, ns: string, name: string): Promise<never> {
  const removed = await db.prepare(
    `SELECT t.removed_category, t.removed_at FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ? AND t.status = 'removed'`,
  ).bind(ns, name).first<{ removed_category: string | null; removed_at: number | null }>();
  if (removed) {
    apiError(410, "tool_removed", `${ns}/${name} was removed from the registry (${removed.removed_category ?? "policy"}) on ${new Date(removed.removed_at ?? 0).toISOString().slice(0, 10)}`,
      "uninstall it with `ot uninstall`; see otinstaller.com/policy/transparency");
  }
  apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
}

export type VersionRow = {
  id: string;
  version: string;
  status: string;
  manifest_json: string;
  signer_identity: string | null;
  signer_issuer: string | null;
  scan_status: string;
  removed_reason: string | null;
  published_at: number | null;
};

export async function findVersion(db: D1Database, toolId: string, version: string): Promise<VersionRow | null> {
  const cols = `id, version, status, manifest_json, signer_identity, signer_issuer, scan_status, removed_reason, published_at`;
  if (version === "latest") {
    return db
      .prepare(`SELECT ${cols} FROM versions WHERE id = (SELECT latest_version_id FROM tools WHERE id = ?)`)
      .bind(toolId)
      .first<VersionRow>();
  }
  return db
    .prepare(`SELECT ${cols} FROM versions WHERE tool_id = ? AND version = ? AND status IN ('published', 'yanked', 'removed')`)
    .bind(toolId, version)
    .first<VersionRow>();
}
