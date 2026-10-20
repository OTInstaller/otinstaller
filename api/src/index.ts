import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import schema from "../../spec/schema/v1.json";
import { rank } from "./ranking";
import { cached, findTool, findVersion, LISTED, rankInput, summary, SUMMARY_COLUMNS, VISIBLE, type SummaryRow } from "./catalog";
import type { AppEnv, Env, PublishMessage } from "./env";
import { apiError } from "./lib/errors";
import { authRoutes } from "./routes/auth";
import { webhookRoutes } from "./routes/webhooks";
import { reviewRoutes } from "./routes/review";
import { sourceRoutes } from "./routes/sources";
import { importRoutes } from "./routes/imports";
import { guideRoutes } from "./routes/guides";
import { queueNightlyLinkChecks } from "./guides";
import { ulid } from "./lib/crypto";
import { pollDueSources } from "./sync";
import { expireStaleScans } from "./scans";
import { handleBatch } from "./publish";

export type { Env } from "./env";

const app = new Hono<AppEnv>().basePath("/v1");

// Public reads are open to any origin; credentialed calls only from the website.
app.use("*", async (c, next) => {
  const site = c.env.SITE_URL;
  return cors({ origin: (o) => (o === site ? o : "*"), credentials: true, allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"] })(c, next);
});
authRoutes(app);
webhookRoutes(app);
reviewRoutes(app);
sourceRoutes(app);
importRoutes(app);
// Registered before the /tools/:ns/:name/:version routes below, which would otherwise take /docs, /guides and /readme.
guideRoutes(app);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // The request ID ties a user's report to the log line; behind Cloudflare it is the cf-ray.
  const requestId = c.req.header("cf-ray") ?? ulid();
  console.error(`request ${requestId}:`, err);
  return c.json({ error: { code: "internal_error", message: "Something went wrong on our side.", request_id: requestId } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));

// Turns free text into a safe FTS5 query: each word becomes a quoted prefix term.
export function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

const INPUT_TYPES: string[] = schema.$defs.inputType.enum;
const ENTITY_TYPES: string[] = schema.$defs.entityType.enum;
const CATEGORIES: string[] = schema.$defs.category.enum;

function oneOf(value: string | undefined, allowed: string[], param: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value)) apiError(400, "invalid_parameter", `${param} must be one of: ${allowed.join(", ")}`);
  return value;
}

// ---------- endpoints ----------

app.get("/health", (c) => c.json({ ok: true }));

app.get("/types", (c) => {
  cached(c, 86400);
  return c.json({ inputs: INPUT_TYPES, outputs: ENTITY_TYPES, categories: CATEGORIES });
});

app.get("/tools", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const input = oneOf(c.req.query("input"), INPUT_TYPES, "input");
  const output = oneOf(c.req.query("output"), ENTITY_TYPES, "output");
  const category = oneOf(c.req.query("category"), CATEGORIES, "category");
  const runtime = oneOf(c.req.query("runtime"), ["docker", "pipx"], "runtime");
  const kind = oneOf(c.req.query("kind"), ["tool", "guide"], "kind");
  // Guide filters; they match nothing but guides.
  const level = oneOf(c.req.query("level"), ["beginner", "intermediate", "advanced"], "level");
  const format = oneOf(c.req.query("format"), ["guide", "reference"], "format");
  const lang = c.req.query("lang")?.trim() || undefined;
  if (lang && !/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) apiError(400, "invalid_parameter", "lang must be a language code such as en or pt-BR");
  const sort = oneOf(c.req.query("sort"), ["relevance", "installs", "stars", "updated"], "sort") ?? "relevance";
  const noKeys = c.req.query("no_keys") === "1" || c.req.query("no_keys") === "true";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
  const offset = Math.max(Number(c.req.query("cursor") ?? 0) || 0, 0);

  // Packages whose source repository disappeared stay installable but leave search.
  const where = [VISIBLE, LISTED];
  const params: unknown[] = [];
  if (input) {
    where.push(`EXISTS (SELECT 1 FROM tool_io WHERE tool_id = t.id AND direction = 'in' AND type = ?)`);
    params.push(input);
  }
  if (output) {
    where.push(`EXISTS (SELECT 1 FROM tool_io WHERE tool_id = t.id AND direction = 'out' AND type = ?)`);
    params.push(output);
  }
  if (category) {
    where.push(`EXISTS (SELECT 1 FROM json_each(t.categories) WHERE value = ?)`);
    params.push(category);
  }
  if (runtime) {
    where.push(`v.runtime_kind = ?`);
    params.push(runtime);
  }
  if (kind) {
    where.push(`t.kind = ?`);
    params.push(kind);
  }
  for (const [field, value] of [["level", level], ["format", format]] as const) {
    if (!value) continue;
    where.push(`t.kind = 'guide' AND json_extract(v.manifest_json, '$.${field}') = ?`);
    params.push(value);
  }
  if (lang) {
    where.push(`t.kind = 'guide' AND COALESCE(json_extract(v.manifest_json, '$.language'), 'en') = ?`);
    params.push(lang);
  }
  if (noKeys) where.push(`NOT EXISTS (SELECT 1 FROM tool_secrets WHERE tool_id = t.id AND required = 1)`);

  const match = ftsQuery(q);
  let rows: (SummaryRow & { bm25?: number })[];
  if (match) {
    // bm25() is negative (more negative = better); flip it so higher is better.
    const sql = `SELECT ${SUMMARY_COLUMNS}, -bm25(tools_fts, 2.0, 4.0, 2.0, 1.0, 0.5) AS bm25
      FROM tools_fts JOIN tools t ON t.rowid = tools_fts.rowid
      JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
      WHERE tools_fts MATCH ? AND ${where.join(" AND ")}
      ORDER BY bm25(tools_fts, 2.0, 4.0, 2.0, 1.0, 0.5) LIMIT 200`;
    rows = (await c.env.DB.prepare(sql).bind(match, ...params).all<SummaryRow & { bm25: number }>()).results;
  } else {
    const sql = `SELECT ${SUMMARY_COLUMNS}, t.updated_at
      FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
      WHERE ${where.join(" AND ")} LIMIT 1000`;
    rows = (await c.env.DB.prepare(sql).bind(...params).all<SummaryRow>()).results;
  }

  const qLower = q.toLowerCase();
  const scored = rows.map((r) => ({
    r,
    score: rank(rankInput(r, match ? r.bm25 : undefined)),
    exact: qLower !== "" && (r.name === qLower || `${r.namespace}/${r.name}` === qLower),
  }));
  const by: Record<string, (a: (typeof scored)[0], b: (typeof scored)[0]) => number> = {
    relevance: (a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score,
    installs: (a, b) => b.r.installs_30d - a.r.installs_30d,
    stars: (a, b) => b.r.stars_count - a.r.stars_count,
    updated: (a, b) => ((b.r as any).updated_at ?? 0) - ((a.r as any).updated_at ?? 0),
  };
  scored.sort(by[sort]);
  const page = scored.slice(offset, offset + limit);
  cached(c, 60);
  return c.json({
    results: page.map((s) => summary(s.r)),
    next_cursor: offset + limit < scored.length ? String(offset + limit) : undefined,
  });
});

// Guides are tools with kind = guide; this is a convenience alias for the website.
app.get("/guides", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/v1/tools";
  url.searchParams.set("kind", "guide");
  return app.fetch(new Request(url, c.req.raw), c.env);
});

app.get("/tools/:ns/:name", async (c) => {
  const { ns, name } = c.req.param();
  const { row, movedTo } = await findTool(c.env.DB, ns, name);
  if (!row) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  cached(c, 60);
  return c.json({
    ...summary(row),
    repo_url: row.repo_url,
    homepage: JSON.parse(row.manifest_json).homepage ?? null,
    license: JSON.parse(row.manifest_json).license,
    deprecated_message: row.deprecated_message ?? undefined,
    manifest: JSON.parse(row.manifest_json),
    moved_to: movedTo,
  });
});

app.get("/tools/:ns/:name/versions", async (c) => {
  const { ns, name } = c.req.param();
  const { row } = await findTool(c.env.DB, ns, name);
  if (!row) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  const versions = await c.env.DB.prepare(
    `SELECT version, status, scan_status, published_at, yanked_at, signer_identity IS NOT NULL AS signed
     FROM versions WHERE tool_id = ? AND status IN ('published', 'yanked', 'removed')
     ORDER BY semver_major DESC, semver_minor DESC, semver_patch DESC, semver_pre = '' DESC, semver_pre DESC`,
  )
    .bind(row.id)
    .all();
  cached(c, 60);
  return c.json({ versions: versions.results.map((v: any) => ({ ...v, signed: v.signed === 1 && row.manifest_mode !== "registry" })) });
});

app.get("/tools/:ns/:name/:version/manifest", async (c) => {
  const { ns, name, version } = c.req.param();
  const { row, movedTo } = await findTool(c.env.DB, ns, name);
  if (!row) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  const v = await findVersion(c.env.DB, row.id, version);
  if (!v) apiError(404, "version_not_found", `${ns}/${name} has no version ${version}`);
  // Removed versions return their status so the CLI can explain why it refuses, but no manifest.
  const removed = v.status === "removed";
  cached(c, version === "latest" ? 60 : 3600);
  return c.json({
    ref: `${row.namespace}/${row.name}`,
    version: v.version,
    status: v.status,
    removed_reason: removed ? v.removed_reason : undefined,
    signer_identity: v.signer_identity ?? undefined,
    signer_issuer: v.signer_issuer ?? undefined,
    scan_status: v.scan_status,
    health: row.health_status,
    verified_publisher: row.verified === 1,
    source_unavailable: row.source_status === "unavailable",
    moved_to: movedTo,
    manifest: removed ? null : JSON.parse(v.manifest_json),
  });
});

app.get("/tools/:ns/:name/:version", async (c) => {
  const { ns, name, version } = c.req.param();
  const { row } = await findTool(c.env.DB, ns, name);
  if (!row) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  const v = await findVersion(c.env.DB, row.id, version);
  if (!v || v.status === "removed") apiError(404, "version_not_found", `${ns}/${name} has no version ${version}`);
  cached(c, 3600);
  return c.json({
    ref: `${row.namespace}/${row.name}`,
    version: v.version,
    status: v.status,
    published_at: v.published_at,
    scan_status: v.scan_status,
    signed: !!v.signer_identity && row.manifest_mode !== "registry",
    manifest: JSON.parse(v.manifest_json),
  });
});

app.get("/namespaces/:ns", async (c) => {
  const ns = c.req.param("ns");
  const n = await c.env.DB.prepare(
    `SELECT name, kind, provider, display_name, avatar_url, verified, created_at FROM namespaces WHERE name = ? AND status = 'active'`,
  )
    .bind(ns)
    .first<any>();
  if (!n) apiError(404, "namespace_not_found", `${ns} is not a registry namespace`);
  const tools = await c.env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     JOIN versions v ON v.id = t.latest_version_id WHERE n.name = ? AND ${VISIBLE} ORDER BY t.installs_30d DESC`,
  )
    .bind(ns)
    .all<SummaryRow>();
  cached(c, 300);
  return c.json({ ...n, verified: n.verified === 1, tools: tools.results.map(summary) });
});

// Tools whose inputs accept the given output types, for chaining results into the next lookup.
app.get("/pivots", async (c) => {
  const from = (c.req.query("from") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (from.length === 0) apiError(400, "invalid_parameter", "from must list one or more entity types");
  for (const t of from) oneOf(t, ENTITY_TYPES, "from");
  // Entity types that are also input types (email, username, domain, ...) can feed another tool.
  const usable = from.filter((t) => INPUT_TYPES.includes(t));
  const pivots: Record<string, ReturnType<typeof summary>[]> = {};
  for (const type of usable) {
    const rows = await c.env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM tools t JOIN namespaces n ON n.id = t.namespace_id
       JOIN versions v ON v.id = t.latest_version_id
       WHERE ${VISIBLE} AND ${LISTED} AND t.kind = 'tool' AND t.health_status != 'broken'
       AND EXISTS (SELECT 1 FROM tool_io WHERE tool_id = t.id AND direction = 'in' AND type = ?)`,
    )
      .bind(type)
      .all<SummaryRow>();
    pivots[type] = rows.results
      .map((r) => ({ r, s: rank(rankInput(r)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => summary(x.r));
  }
  cached(c, 600);
  return c.json({ pivots });
});

// Anonymous install counts: no IP, user or token is stored, only a per-day counter.
app.post("/installs", async (c) => {
  const body = await c.req.json<{ tool?: string; version?: string }>().catch(() => ({}) as { tool?: string; version?: string });
  const [ns, name] = (body.tool ?? "").split("/");
  if (!ns || !name || !body.version) apiError(400, "invalid_body", "send {tool: 'namespace/name', version}");
  const v = await c.env.DB.prepare(
    `SELECT t.id AS tool_id, v.id AS version_id FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     JOIN versions v ON v.tool_id = t.id WHERE n.name = ? AND t.name = ? AND v.version = ? AND v.status = 'published'`,
  )
    .bind(ns, name, body.version)
    .first<{ tool_id: string; version_id: string }>();
  if (!v) return c.body(null, 204);
  const day = new Date().toISOString().slice(0, 10);
  await c.env.DB.prepare(
    `INSERT INTO install_counts (tool_id, version_id, day, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (tool_id, version_id, day) DO UPDATE SET count = count + 1`,
  )
    .bind(v.tool_id, v.version_id, day)
    .run();
  return c.body(null, 204);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<PublishMessage>, env: Env) => handleBatch(batch, env),
  async scheduled(event: ScheduledController, env: Env) {
    // Every 15 minutes: close scans that never reported back, and poll sources that are due.
    await expireStaleScans(env);
    await pollDueSources(env);
    // Nightly: recompute 30-day install totals that ranking uses, and re-check guides' links.
    if (event.cron === "17 3 * * *") {
      await queueNightlyLinkChecks(env);
      await env.DB.prepare(
        `UPDATE tools SET installs_30d = COALESCE((SELECT SUM(count) FROM install_counts
           WHERE tool_id = tools.id AND day >= date('now', '-30 days')), 0)`,
      ).run();
    }
  },
} satisfies ExportedHandler<Env, PublishMessage>;

export { app };
