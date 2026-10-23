// What changed in the registry, from the audit log: releases, yanks, deprecations and transfers of packages anyone
// can see, and (with events=community or all) issues the community confirmed or got fixed and tool requests accepted
// or published. Serves GET /activity (index.ts), which the site's feeds, "What's new" page and community board read; a
// namespace's own activity (routes/profiles.ts) uses the same event names. Nothing here exposes reasons, reports, who
// acted, or anything people wrote: community events are worded from fields, never from issue titles or notes.
import { LISTED, VISIBLE } from "./catalog";
import { firstWeekCounts, type FirstWeek } from "./first-week";

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
  /** registry (the default): releases, yanks, deprecations, transfers; community: confirmed and fixed issues, accepted
   * and published tool requests; all: both. */
  events?: "registry" | "community" | "all";
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
  /** Community events: the issue's or request's number. */
  number?: number;
  /** issue_confirmed and issue_fixed: the issue's kind (broken, outdated, ...). */
  issue_kind?: string;
  /** request_published: the package that answers it. */
  tool?: string;
  /** published, in the version's first week: what signed-in people said about it so far (first-week.ts). */
  first_week?: FirstWeek;
}

type Row = {
  id: string; action: string; created_at: number; namespace: string; name: string; kind: string; summary: string;
  version: string | null; first: number | null; notes: number | null; replacement: string | null; meta: string | null; version_id: string | null;
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
  const which = q.events ?? "registry";
  // Each part is filtered on its own, so each carries its binds.
  const parts: { sql: string; binds: unknown[] }[] = [];
  if (which !== "community") {
    parts.push({
      sql: `SELECT a.id AS id, a.action AS action, a.created_at AS created_at, n.name AS namespace, t.name AS name, t.kind AS kind, t.summary AS summary, v.version AS version,
         NOT EXISTS (SELECT 1 FROM versions p WHERE p.tool_id = t.id AND p.status IN ('published', 'yanked') AND p.published_at < v.published_at) AS first,
         COALESCE(v.changelog, '') != '' AS notes, NULL AS replacement, NULL AS meta, v.id AS version_id
       FROM audit_log a JOIN versions v ON v.id = a.target_id JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE a.target_kind = 'version' AND a.action IN (${list(VERSION_ACTIONS)}) AND v.status != 'removed' AND ${VISIBLE} AND ${LISTED}${extra}`,
      binds,
    }, {
      sql: `SELECT a.id, a.action, a.created_at, n.name, t.name, t.kind, t.summary, NULL, NULL, NULL, t.deprecated_replacement, a.metadata_json, NULL
       FROM audit_log a JOIN tools t ON t.id = a.target_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE a.target_kind = 'tool' AND a.action IN (${list(TOOL_ACTIONS)}) AND ${VISIBLE} AND ${LISTED}${extra}`,
      binds,
    });
  }
  if (which !== "registry") {
    // Issues confirmed or fixed, on packages anyone can see; the issue's own title is never used.
    parts.push({
      sql: `SELECT a.id AS id, a.action AS action, a.created_at AS created_at, n.name AS namespace, t.name AS name, t.kind AS kind, t.summary AS summary,
         NULL AS version, NULL AS first, NULL AS notes, NULL AS replacement,
         json_object('number', i.number, 'to', json_extract(a.metadata_json, '$.to'), 'issue_kind', i.kind) AS meta, NULL AS version_id
       FROM audit_log a JOIN issues i ON i.id = a.target_id JOIN tools t ON t.id = i.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE a.target_kind = 'issue' AND a.action = 'issue.status' AND json_extract(a.metadata_json, '$.to') IN ('confirmed', 'fixed')
         AND i.moderation = 'visible' AND i.deleted_at IS NULL AND ${VISIBLE} AND ${LISTED}${extra}`,
      binds,
    });
    // Tool requests aren't packages yet, so publisher and input filters leave them out.
    if (!q.namespace && !q.input && q.kind !== "guide") {
      parts.push({
        sql: `SELECT a.id AS id, a.action AS action, a.created_at AS created_at, '' AS namespace, r.repo_path AS name, 'request' AS kind, '' AS summary,
           NULL AS version, NULL AS first, NULL AS notes, tn.name || '/' || tt.name AS replacement, json_object('number', r.number) AS meta, NULL AS version_id
         FROM audit_log a JOIN tool_requests r ON r.id = a.target_id LEFT JOIN tools tt ON tt.id = r.tool_id LEFT JOIN namespaces tn ON tn.id = tt.namespace_id
         WHERE a.target_kind = 'request' AND a.action IN ('request.accepted', 'request.published') AND r.moderation = 'visible'${q.before ? " AND a.created_at < ?" : ""}`,
        binds: q.before ? [q.before] : [],
      });
    }
  }
  const rows = (await db.prepare(`${parts.map((p) => p.sql).join("\n UNION ALL\n ")}\n ORDER BY created_at DESC LIMIT ?`)
    .bind(...parts.flatMap((p) => p.binds), q.limit).all<Row>()).results;
  const firstWeek = await firstWeekCounts(db, rows.filter((r) => r.action === "version.published" && r.version_id).map((r) => ({ id: r.version_id!, published_at: r.created_at })));
  const events = rows.map((r): ActivityEvent => {
    if (r.action === "issue.status") {
      const m = JSON.parse(r.meta ?? "{}") as { number: number; to: string; issue_kind: string };
      return { id: r.id, type: `issue_${m.to}`, ref: `${r.namespace}/${r.name}`, kind: r.kind, summary: r.summary, at: r.created_at, number: m.number, issue_kind: m.issue_kind };
    }
    if (r.action === "request.accepted" || r.action === "request.published") {
      const m = JSON.parse(r.meta ?? "{}") as { number: number };
      const tool = r.action === "request.published" && r.replacement ? r.replacement : undefined;
      return {
        id: r.id, type: r.action.replace(".", "_"), ref: r.name, kind: "request", at: r.created_at, number: m.number, ...(tool ? { tool } : {}),
        summary: tool ? `${r.name} is in the registry as ${tool}` : `A triager accepted the request to package ${r.name}`,
      };
    }
    const type = ACTIVITY[r.action] ?? r.action;
    const meta = r.action === "transfer.complete" ? (JSON.parse(r.meta ?? "{}") as { from?: string; to?: string }) : {};
    return {
      id: r.id, type, ref: `${r.namespace}/${r.name}`, kind: r.kind, summary: r.summary, at: r.created_at,
      ...(r.version ? { version: r.version } : {}),
      ...(r.action === "version.published" ? { new_package: r.first === 1, has_notes: r.notes === 1 } : {}),
      ...(r.action === "version.published" && r.version_id && firstWeek.has(r.version_id) ? { first_week: firstWeek.get(r.version_id) } : {}),
      ...(type === "deprecated" && r.replacement ? { replacement: r.replacement } : {}),
      ...(meta.from ? { from: meta.from, to: meta.to } : {}),
    };
  });
  return { events, next_before: rows.length === q.limit ? rows.at(-1)!.created_at : null };
}
