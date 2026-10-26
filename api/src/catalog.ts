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
  t.installs_30d, t.health_status, t.health_checked_at, t.community_packaged, t.needs_update, n.verified,
  v.version AS latest_version, v.runtime_kind, v.signer_identity, v.published_at AS published_at,
  t.title, t.level, t.format, t.language,
  (SELECT s.manifest_mode FROM sources s WHERE s.tool_id = t.id) AS manifest_mode,
  (SELECT s.sync_status FROM sources s WHERE s.tool_id = t.id) AS source_status,
  (SELECT group_concat(type) FROM tool_io WHERE tool_id = t.id AND direction = 'in') AS inputs,
  (SELECT group_concat(type) FROM tool_io WHERE tool_id = t.id AND direction = 'out') AS outputs,
  EXISTS (SELECT 1 FROM tool_secrets WHERE tool_id = t.id AND required = 1) AS needs_keys,
  t.touches_target, t.auth_required, t.collects_personal_data, t.notifies_target, t.egress`;

/**
 * What search filters and summaries read from the latest version's manifest, copied onto tools so a search doesn't
 * parse the manifest of every candidate: `UPDATE tools SET ${SEARCH_FIELDS} FROM versions v WHERE v.id = ...`.
 * latestMetadata runs it whenever the latest version changes; migration 0042 and the seed ran the same for every tool.
 * Null where the manifest leaves a field out, as json_extract gives.
 */
export const SEARCH_FIELDS = `title = json_extract(v.manifest_json, '$.title'), level = json_extract(v.manifest_json, '$.level'),
  format = json_extract(v.manifest_json, '$.format'), language = json_extract(v.manifest_json, '$.language'),
  touches_target = json_extract(v.manifest_json, '$.ethics.touches_target'), auth_required = json_extract(v.manifest_json, '$.ethics.auth_required'),
  collects_personal_data = json_extract(v.manifest_json, '$.ethics.collects_personal_data'),
  notifies_target = json_extract(v.manifest_json, '$.ethics.notifies_target'), egress = json_extract(v.manifest_json, '$.network.egress')`;

export type SummaryRow = {
  id: string;
  rowid: number;
  namespace: string;
  name: string;
  kind: string;
  summary: string;
  categories: string;
  status: string;
  installs_30d: number;
  health_status: string;
  health_checked_at: number | null;
  community_packaged: number;
  needs_update: number;
  verified: number;
  latest_version: string;
  published_at: number | null;
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
  touches_target: number | null;
  auth_required: number | null;
  collects_personal_data: number | null;
  notifies_target: number | null;
  egress: number | null;
};

export function summary(r: SummaryRow) {
  const guide = r.kind === "guide";
  return {
    namespace: r.namespace,
    name: r.name,
    kind: r.kind,
    summary: r.summary,
    latest_version: r.latest_version,
    // When the latest version was published (ms).
    published_at: r.published_at ?? null,
    categories: JSON.parse(r.categories) as string[],
    inputs: r.inputs ? r.inputs.split(",").sort() : [],
    outputs: r.outputs ? r.outputs.split(",").sort() : [],
    runtime: r.runtime_kind,
    // Nothing records stars; kept at 0 so older clients that read the field keep working.
    stars: 0,
    installs_30d: r.installs_30d,
    health: r.health_status,
    // When someone last said the latest version works (ms), so the site can say "reported working yesterday"; null
    // when nobody has in 30 days.
    health_checked_at: r.health_checked_at ?? null,
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
    // Tools only: what a run does, so agents and scripts can tell which runs need consent without the manifest.
    ...(guide ? {} : {
      ethics: { touches_target: r.touches_target === 1, auth_required: r.auth_required === 1, collects_personal_data: r.collects_personal_data === 1, ...(r.notifies_target === null || r.notifies_target === undefined ? {} : { notifies_target: r.notifies_target === 1 }) },
      egress: r.egress === 1,
    }),
  };
}

export function rankInput(r: SummaryRow, bm25?: number): RankInput {
  return {
    bm25,
    installs30d: r.installs_30d,
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
  open_broken: number;
  open_outdated: number;
};

export async function findTool(db: D1Database, ns: string, name: string): Promise<{ row: ToolRow | null; movedTo?: string }> {
  const sql = `SELECT ${SUMMARY_COLUMNS}, t.repo_url, t.deprecated_message, t.deprecated_replacement, t.latest_version_id, t.dead_link_ratio, t.open_broken, t.open_outdated, v.manifest_json, n.status AS namespace_status
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

/**
 * Every visible package's latest version and lifecycle, plus the old addresses of packages that moved: what `ot`
 * compares installed packages with once a day, without telling the registry which ones it has. Packages whose source
 * is gone are included (they leave search but stay installed).
 */
export async function latestVersions(db: D1Database) {
  const [packages, moved] = await db.batch([
    db.prepare(
      `SELECT n.name AS ns, t.name, t.kind, v.version AS latest, t.status, t.health_status, t.deprecated_replacement,
         EXISTS (SELECT 1 FROM sources s WHERE s.tool_id = t.id AND s.sync_status = 'unavailable') AS source_unavailable
       FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
       WHERE ${VISIBLE} ORDER BY n.name, t.name`,
    ),
    db.prepare(
      `SELECT a.old_namespace || '/' || a.old_name AS "from", n.name || '/' || t.name AS "to"
       FROM aliases a JOIN tools t ON t.id = a.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE ${VISIBLE} ORDER BY 1`,
    ),
  ]);
  type Row = { ns: string; name: string; kind: string; latest: string; status: string; health_status: string; deprecated_replacement: string | null; source_unavailable: number };
  const rows = (packages?.results ?? []) as Row[];
  const refs = new Set(rows.map((r) => `${r.ns}/${r.name}`));
  return {
    packages: rows.map((r) => ({
      ref: `${r.ns}/${r.name}`,
      kind: r.kind,
      latest: r.latest,
      status: r.status,
      health: r.health_status,
      ...(r.status === "deprecated" && r.deprecated_replacement ? { replacement: r.deprecated_replacement } : {}),
      ...(r.source_unavailable ? { source_unavailable: true } : {}),
    })),
    // A package published at an address wins over an alias of the same name, as in findTool.
    moved: ((moved?.results ?? []) as { from: string; to: string }[]).filter((m) => !refs.has(m.from)),
  };
}

/** Not found: removed packages answer 410 with why, so the CLI and site can say so instead of "not found". */
export async function notFound(db: D1Database, ns: string, name: string): Promise<never> {
  // The package itself was removed, or every version it had published was.
  const removed = await db.prepare(
    `SELECT COALESCE(t.removed_category, v.removed_category) AS removed_category, COALESCE(t.removed_at, v.removed_at) AS removed_at
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     LEFT JOIN versions v ON v.id = (SELECT id FROM versions WHERE tool_id = t.id AND status = 'removed' ORDER BY removed_at DESC LIMIT 1)
     WHERE n.name = ? AND t.name = ? AND (t.status = 'removed' OR (v.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM versions WHERE tool_id = t.id AND status IN ('published', 'yanked'))))`,
  ).bind(ns, name).first<{ removed_category: string | null; removed_at: number | null }>();
  if (removed) {
    apiError(410, "tool_removed", `${ns}/${name} was removed from the registry (${removed.removed_category ?? "policy"}) on ${new Date(removed.removed_at ?? 0).toISOString().slice(0, 10)}`,
      "uninstall it with `ot uninstall`; see otinstaller.com/policy/transparency");
  }
  apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
}

/** How a version came in: a tag ("tag"), an upload from CI ("ci") or a direct upload ("direct"); null without a job. */
export async function publishedVia(db: D1Database, versionId: string): Promise<"tag" | "ci" | "direct" | null> {
  const row = await db.prepare(
    `SELECT CASE WHEN provider = 'direct' THEN 'direct' WHEN bundle_key IS NOT NULL THEN 'ci' ELSE 'tag' END AS via
     FROM publish_jobs WHERE version_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(versionId).first<{ via: "tag" | "ci" | "direct" }>();
  return row?.via ?? null;
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
