// The staff audit log (GET /admin/audit-log in routes/trust.ts): entries newest first, each with a readable target (the
// namespace, package, version, person or link it is about), filtered in SQL by action, actor and target so that paging
// keeps the filters. Rows are written by audit() in routes/auth.ts, in the same batch as the change they record.
import type { Env } from "./env";
import { apiError } from "./lib/errors";
import { shareUrl } from "./shares";

export interface AuditLogQuery {
  /** Only entries before this time (Unix ms), for paging. */
  before: number;
  limit: number;
  /** One action (`namespace.approve`), or every action that starts with a prefix ending in "." (`namespace.`). */
  action?: string;
  /** The login of the person who acted, in any case. */
  actor?: string;
  /** A namespace or namespace/name: entries about it, its packages and what belongs to them (see TARGET_PARTS). */
  target?: string;
}

export interface AuditEntry {
  id: string;
  actor_kind: string;
  actor: string | null;
  action: string;
  target_kind: string;
  target_id: string;
  /** What the entry is about, in words; null once its row is gone, and for feedback. */
  target: string | null;
  metadata: unknown;
  created_at: number;
}

// ---------- readable targets ----------

// A package as it is now (after any move), joined from a row x that has a tool_id.
const REF = `n.name || '/' || t.name`;
const PACKAGE = `JOIN tools t ON t.id = x.tool_id JOIN namespaces n ON n.id = t.namespace_id`;
const MAYBE_PACKAGE = `LEFT JOIN tools t ON t.id = x.tool_id LEFT JOIN namespaces n ON n.id = t.namespace_id`;

/**
 * What an entry reads as, by target kind: the package (with the version or issue number) it belongs to, else the
 * person or link. Each reads the row whose id is a.target_id, so a row that is gone reads as null. Shares are read in
 * code: their link is their id.
 */
const TARGETS: Record<string, string> = {
  namespace: `SELECT name FROM namespaces WHERE id = a.target_id`,
  tool: `SELECT ${REF} FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE t.id = a.target_id`,
  version: `SELECT ${REF} || ' ' || x.version FROM versions x ${PACKAGE} WHERE x.id = a.target_id`,
  // The handle only when it says more than the login.
  user: `SELECT login || CASE WHEN handle IS NULL OR handle = lower(login) THEN '' ELSE ' (@' || handle || ')' END FROM users WHERE id = a.target_id`,
  report: `SELECT ${REF} || COALESCE(' ' || v.version, '') FROM reports x ${PACKAGE} LEFT JOIN versions v ON v.id = x.version_id WHERE x.id = a.target_id`,
  issue: `SELECT ${REF} || '#' || x.number FROM issues x ${PACKAGE} WHERE x.id = a.target_id`,
  comment: `SELECT ${REF} || '#' || x.number FROM issue_comments c JOIN issues x ON x.id = c.issue_id ${PACKAGE} WHERE c.id = a.target_id`,
  transfer: `SELECT ${REF} FROM transfers x ${PACKAGE} WHERE x.id = a.target_id`,
  submission: `SELECT COALESCE(${REF}, x.upstream_url) FROM wrapper_submissions x ${MAYBE_PACKAGE} WHERE x.id = a.target_id`,
  publish_job: `SELECT COALESCE(${REF} || COALESCE(' ' || v.version, ''), x.repo || ' ' || x.tag)
    FROM publish_jobs x ${MAYBE_PACKAGE} LEFT JOIN versions v ON v.id = x.version_id WHERE x.id = a.target_id`,
  source: `SELECT COALESCE(${REF}, x.url) FROM sources x ${MAYBE_PACKAGE} WHERE x.id = a.target_id`,
  request: `SELECT url FROM tool_requests WHERE id = a.target_id`,
  request_comment: `SELECT r.url FROM request_comments x JOIN tool_requests r ON r.id = x.request_id WHERE x.id = a.target_id`,
  token: `SELECT x.name || ' (' || u.login || ')' FROM api_tokens x JOIN users u ON u.id = x.user_id WHERE x.id = a.target_id`,
  // A bulk import is audited under its batch id, which has no row of its own.
  import: `SELECT COALESCE(url, provider || ':' || path) FROM imports WHERE id = a.target_id`,
  // Audited under GitHub's installation id, not the row's.
  installation: `SELECT account_login FROM installations WHERE github_installation_id = a.target_id`,
};

const TARGET = `CASE a.target_kind ${Object.entries(TARGETS).map(([kind, sql]) => `WHEN '${kind}' THEN (${sql})`).join(" ")} END`;

// ---------- filters ----------

/** Kinds of target that belong to a package besides the package itself: where their rows are, and its column there. */
const TARGET_PARTS: [kind: string, from: string, tool: string][] = [
  ["version", "versions x", "x.tool_id"],
  ["report", "reports x", "x.tool_id"],
  ["issue", "issues x", "x.tool_id"],
  ["comment", "issue_comments x JOIN issues i ON i.id = x.issue_id", "i.tool_id"],
  ["transfer", "transfers x", "x.tool_id"],
  ["submission", "wrapper_submissions x", "x.tool_id"],
  ["publish_job", "publish_jobs x", "x.tool_id"],
  ["source", "sources x", "x.tool_id"],
];

/**
 * What a namespace or namespace/name filter matches, as a WITH clause and a condition on the entry: the namespace
 * itself, its packages as they are now (or the one package, also found at an address it moved from), and every row in
 * TARGET_PARTS that belongs to them. Each part is looked up through the audit log's target index, so the log is never
 * read whole. ORs rather than a UNION: D1 allows only five terms in a compound SELECT.
 */
async function targetFilter(env: Env, target: string): Promise<{ cte: string; binds: string[]; where: string }> {
  const [ns, name] = target.split("/") as [string, string?];
  const parts = [
    `a.target_kind = 'tool' AND a.target_id IN packages`,
    ...TARGET_PARTS.map(([kind, from, tool]) => `a.target_kind = '${kind}' AND a.target_id IN (SELECT x.id FROM ${from} WHERE ${tool} IN packages)`),
  ];
  const any = (conditions: string[]) => conditions.map((p) => `(${p})`).join(" OR ");
  if (name === undefined) {
    const n = await env.DB.prepare(`SELECT id FROM namespaces WHERE name = ?`).bind(ns).first<{ id: string }>();
    if (!n) apiError(404, "namespace_not_found", `${ns} is not a namespace`);
    return {
      cte: `WITH ns(id) AS (SELECT ?), packages(id) AS (SELECT id FROM tools WHERE namespace_id IN ns)`,
      binds: [n.id],
      where: any([`a.target_kind = 'namespace' AND a.target_id IN ns`, ...parts]),
    };
  }
  const t = await env.DB.prepare(
    `SELECT COALESCE((SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ?1 AND t.name = ?2),
       (SELECT tool_id FROM aliases WHERE old_namespace = ?1 AND old_name = ?2)) AS id`,
  ).bind(ns, name).first<{ id: string | null }>();
  if (!t?.id) apiError(404, "tool_not_found", `${target} is not in the registry`);
  return { cte: `WITH packages(id) AS (SELECT ?)`, binds: [t.id], where: any(parts) };
}

/** A page of the audit log, newest first. An actor or target that doesn't exist is a 404, not an empty page. */
export async function auditLog(env: Env, q: AuditLogQuery): Promise<{ entries: AuditEntry[]; next_before?: number }> {
  const db = env.DB;
  const where = ["a.created_at < ?"];
  const binds: unknown[] = [q.before];
  const targets = q.target ? await targetFilter(env, q.target) : null;
  if (targets) where.push(`(${targets.where})`);
  if (q.action?.endsWith(".")) {
    // substr, not LIKE: _ is a LIKE wildcard, and many actions have one.
    where.push("substr(a.action, 1, ?) = ?");
    binds.push(q.action.length, q.action);
  } else if (q.action) {
    where.push("a.action = ?");
    binds.push(q.action);
  }
  if (q.actor) {
    const ids = (await db.prepare(`SELECT id FROM users WHERE login = ? COLLATE NOCASE`).bind(q.actor).all<{ id: string }>()).results.map((u) => u.id);
    if (!ids.length) apiError(404, "user_not_found", `nobody signs in as ${q.actor}`);
    where.push(`a.actor_id IN (${ids.map(() => "?").join(", ")})`);
    binds.push(...ids);
  }
  const rows = (await db.prepare(
    `${targets?.cte ?? ""} SELECT a.id, a.actor_kind, u.login AS actor, a.action, a.target_kind, a.target_id, ${TARGET} AS target, a.metadata_json, a.created_at
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ?`,
  ).bind(...(targets?.binds ?? []), ...binds, q.limit).all<Omit<AuditEntry, "metadata"> & { metadata_json: string | null }>()).results;
  const entries = rows.map(({ metadata_json, ...r }) => ({
    ...r,
    // The takedown that audits a share deletes its row, so its link is made from the id.
    target: r.target_kind === "share" ? shareUrl(env, r.target_id) : r.target,
    metadata: metadata_json ? JSON.parse(metadata_json) : null,
  }));
  return { entries, next_before: entries.length === q.limit ? entries.at(-1)!.created_at : undefined };
}
