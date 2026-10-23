// What changed in the registry, from the audit log: releases, yanks, deprecations and transfers of packages anyone
// can see. Serves GET /activity (index.ts), which the site's feeds and "What's new" page read; a namespace's own
// activity (routes/profiles.ts) uses the same event names. Nothing here exposes reasons, reports or who acted.
import { LISTED, VISIBLE } from "./catalog";

/** Audit actions that are public events, and the event type each becomes. */
export const ACTIVITY: Record<string, string> = {
  "version.published": "published",
  "version.yank": "yanked",
  "version.unyank": "unyanked",
  "tool.deprecate": "deprecated",
  "tool.deprecated_archived": "deprecated",
  "tool.undeprecate": "undeprecated",
  "transfer.complete": "transferred",
};

const VERSION_ACTIONS = ["version.published", "version.yank", "version.unyank"];
const TOOL_ACTIONS = ["tool.deprecate", "tool.deprecated_archived", "tool.undeprecate", "transfer.complete"];

export interface ActivityQuery {
  limit: number;
  /** Only events before this time (Unix ms), for paging. */
  before?: number;
  kind?: "tool" | "guide";
  /** Only packages that take this input type. */
  input?: string;
  /** Only one publisher's packages. */
  namespace?: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  ref: string;
  kind: string;
  summary: string;
  at: number;
  version?: string;
  /** The package's first release. */
  new_package?: boolean;
  /** The version has release notes (GET /tools/:ns/:name/:version has them). */
  has_notes?: boolean;
  /** What to use instead, for a deprecation that names one. */
  replacement?: string;
  from?: string;
  to?: string;
}

type Row = {
  id: string; action: string; created_at: number; namespace: string; name: string; kind: string; summary: string;
  version: string | null; first: number | null; notes: number | null; replacement: string | null; meta: string | null;
};

/** The newest public events across the registry, newest first, with where the next page starts. */
export async function siteActivity(db: D1Database, q: ActivityQuery): Promise<{ events: ActivityEvent[]; next_before: number | null }> {
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (q.before) {
    filters.push(`a.created_at < ?`);
    binds.push(q.before);
  }
  if (q.kind) {
    filters.push(`t.kind = ?`);
    binds.push(q.kind);
  }
  if (q.namespace) {
    filters.push(`n.name = ?`);
    binds.push(q.namespace);
  }
  if (q.input) {
    filters.push(`EXISTS (SELECT 1 FROM tool_io WHERE tool_id = t.id AND direction = 'in' AND type = ?)`);
    binds.push(q.input);
  }
  const extra = filters.map((f) => ` AND ${f}`).join("");
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(", ");
  // Each half is filtered on its own, so both carry the same binds.
  const rows = (await db.prepare(
    `SELECT a.id AS id, a.action AS action, a.created_at AS created_at, n.name AS namespace, t.name AS name, t.kind AS kind, t.summary AS summary, v.version AS version,
       NOT EXISTS (SELECT 1 FROM versions p WHERE p.tool_id = t.id AND p.status IN ('published', 'yanked') AND p.published_at < v.published_at) AS first,
       COALESCE(v.changelog, '') != '' AS notes, NULL AS replacement, NULL AS meta
     FROM audit_log a JOIN versions v ON v.id = a.target_id JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE a.target_kind = 'version' AND a.action IN (${list(VERSION_ACTIONS)}) AND v.status != 'removed' AND ${VISIBLE} AND ${LISTED}${extra}
     UNION ALL
     SELECT a.id, a.action, a.created_at, n.name, t.name, t.kind, t.summary, NULL, NULL, NULL, t.deprecated_replacement, a.metadata_json
     FROM audit_log a JOIN tools t ON t.id = a.target_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE a.target_kind = 'tool' AND a.action IN (${list(TOOL_ACTIONS)}) AND ${VISIBLE} AND ${LISTED}${extra}
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(...binds, ...binds, q.limit).all<Row>()).results;
  const events = rows.map((r): ActivityEvent => {
    const type = ACTIVITY[r.action] ?? r.action;
    const meta = r.action === "transfer.complete" ? (JSON.parse(r.meta ?? "{}") as { from?: string; to?: string }) : {};
    return {
      id: r.id, type, ref: `${r.namespace}/${r.name}`, kind: r.kind, summary: r.summary, at: r.created_at,
      ...(r.version ? { version: r.version } : {}),
      ...(r.action === "version.published" ? { new_package: r.first === 1, has_notes: r.notes === 1 } : {}),
      ...(type === "deprecated" && r.replacement ? { replacement: r.replacement } : {}),
      ...(meta.from ? { from: meta.from, to: meta.to } : {}),
    };
  });
  return { events, next_before: rows.length === q.limit ? rows.at(-1)!.created_at : null };
}
