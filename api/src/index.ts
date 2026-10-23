import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import schema from "../../spec/schema/v1.json";
import pivotMap from "../../spec/pivots.json";
import typeDescriptions from "../../spec/types.json";
import openapi from "../../spec/openapi/v1.json";
import { rank } from "./ranking";
import { cached, findTool, findVersion, notFound, LISTED, publishedVia, rankInput, summary, SUMMARY_COLUMNS, VISIBLE, type SummaryRow } from "./catalog";
import type { AppEnv, Env, PublishMessage } from "./env";
import { apiError, errorDocs, rateLimited, windowRetry } from "./lib/errors";
import { authRoutes } from "./routes/auth";
import { webhookRoutes } from "./routes/webhooks";
import { reviewRoutes } from "./routes/review";
import { sourceRoutes } from "./routes/sources";
import { importRoutes } from "./routes/imports";
import { guideRoutes } from "./routes/guides";
import { trustRoutes } from "./routes/trust";
import { transferRoutes } from "./routes/transfers";
import { opsRoutes } from "./routes/ops";
import { betaRoutes } from "./routes/beta";
import { backupRoutes } from "./routes/backups";
import { profileRoutes } from "./routes/profiles";
import { communityRoutes } from "./routes/community";
import { inboxRoutes } from "./routes/inbox";
import { requestRoutes } from "./routes/requests";
import { peopleRoutes } from "./routes/people";
import { submissionRoutes } from "./routes/submissions";
import { refreshContributorStats } from "./people";
import { publicWatch, queueUpstreamChecks, type WatchRow } from "./upstream";
import { openBumpFor } from "./bumps";
import { upstreamRoutes } from "./routes/upstream";
import { proposalRoutes } from "./routes/proposals";
import { deliverInbox, purgeInbox } from "./inbox";
import { directRoutes } from "./routes/direct";
import { purgeIdleNamespaces } from "./direct";
import { refreshDueProfiles } from "./profiles";
import { backfillBackups, expireDrills, expireRuns, installFallbacks, purgeBackups, queueMirrorSweeps, RESTORE_DRILL_CRON, startDrill, WEEKLY_BACKUP_CRON, weeklyBackups } from "./backups";
import { alertStuckJobs, dailyDigest, purgeRateLimits, reportError } from "./ops";
import { queueNightlyLinkChecks } from "./guides";
import { ulid } from "./lib/crypto";
import { overLimit } from "./trust";
import { pollDueSources } from "./sync";
import { expireStaleScans } from "./scans";
import { handleBatch } from "./publish";
import { edgeCached } from "./edge-cache";
import { compatManifest } from "./lib/manifest";
import { renderNotes } from "./changelog";
import { siteActivity } from "./activity";
import { firstWeekCounts } from "./first-week";
import { mcpEndpoint } from "./mcp";
import { lockStaleThreads } from "./community";

export type { Env } from "./env";

const app = new Hono<AppEnv>().basePath("/v1");

// Public reads are open to any origin; credentialed calls only from the website. Browsers refuse
// `*` together with credentials, so other origins get `*` without them.
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const publicCors = cors({ origin: "*", allowMethods: METHODS });
app.use("*", async (c, next) => {
  if (c.req.header("origin") !== c.env.SITE_URL) return publicCors(c, next);
  return cors({ origin: c.env.SITE_URL, credentials: true, allowMethods: METHODS })(c, next);
});
authRoutes(app);
// Writes (stars, yanks, tokens, imports, reports, ...) are limited to 30 a minute per signed-in user;
// reviewers and admins are exempt so takedowns are never throttled.
app.use("*", async (c, next) => {
  const u = c.get("user");
  if (u && !u.is_reviewer && !u.is_admin && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    && (await overLimit(c.env, "write", u.id, 30, 60_000))) {
    rateLimited("too_many_requests", "at most 30 changes a minute", "wait a minute and try again", windowRetry(60_000), 30, 60);
  }
  await next();
});
webhookRoutes(app);
reviewRoutes(app);
sourceRoutes(app);
importRoutes(app);
// Registered before the /tools/:ns/:name/:version routes below, which would otherwise take /docs, /guides and /readme.
guideRoutes(app);
trustRoutes(app);
transferRoutes(app);
opsRoutes(app);
betaRoutes(app);
backupRoutes(app);
profileRoutes(app);
communityRoutes(app);
inboxRoutes(app);
requestRoutes(app);
peopleRoutes(app);
submissionRoutes(app);
upstreamRoutes(app);
directRoutes(app);
proposalRoutes(app);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // The request ID ties a user's report to the log line; behind Cloudflare it is the cf-ray.
  const requestId = c.req.header("cf-ray") ?? ulid();
  c.executionCtx.waitUntil(reportError(c.env, err, { requestId, method: c.req.method, path: new URL(c.req.url).pathname }));
  console.error(`request ${requestId}:`, err);
  return c.json({
    error: {
      code: "internal_error",
      message: "Something went wrong on our side.",
      hint: `try again; if it keeps happening, report it with request ID ${requestId}`,
      docs: errorDocs("internal_error"),
      request_id: requestId,
    },
  }, 500);
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "No such endpoint.", hint: "the API reference is at /v1/openapi.json", docs: errorDocs("not_found") } }, 404));

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
// Which input types each entity type can feed (spec/pivots.json, shared with ot).
const PIVOTS = pivotMap.pivots as Record<string, { input: string; attr?: string; transform?: string }[]>;

function oneOf(value: string | undefined, allowed: string[], param: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value)) apiError(400, "invalid_parameter", `${param} must be one of: ${allowed.join(", ")}`, undefined, { parameter: param, allowed });
  return value;
}

// ---------- endpoints ----------

app.get("/health", (c) => c.json({ ok: true }));

// The API reference (spec/openapi/v1.json); a test checks it lists every public and owner route.
app.get("/openapi.json", (c) => {
  cached(c, 3600);
  return c.json(openapi);
});

app.get("/types", (c) => {
  cached(c, 86400);
  return c.json({
    inputs: INPUT_TYPES, outputs: ENTITY_TYPES, categories: CATEGORIES, pivots: PIVOTS,
    // What each value means (spec/types.json).
    descriptions: { inputs: typeDescriptions.inputs, outputs: typeDescriptions.entities, categories: typeDescriptions.categories },
  });
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
  const sort = oneOf(c.req.query("sort"), ["relevance", "installs", "stars", "updated", "health"], "sort") ?? "relevance";
  const noKeys = c.req.query("no_keys") === "1" || c.req.query("no_keys") === "true";
  // Tools that run offline, touch no target and collect no personal data: what agents may run without asking.
  const passiveOnly = c.req.query("passive_only") === "1" || c.req.query("passive_only") === "true";
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
  if (passiveOnly) {
    where.push(`t.kind = 'tool' AND COALESCE(json_extract(v.manifest_json, '$.ethics.touches_target'), 1) = 0
      AND COALESCE(json_extract(v.manifest_json, '$.ethics.collects_personal_data'), 1) = 0
      AND COALESCE(json_extract(v.manifest_json, '$.network.egress'), 0) = 0`);
  }

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
    // "Recently verified working": healthy tools by the time of their last passing nightly check, then the rest.
    health: (a, b) => {
      const h = (x: typeof a) => (x.r.health_status === "healthy" ? 2 : x.r.health_status === "broken" ? 0 : 1);
      return h(b) - h(a) || (b.r.health_checked_at ?? 0) - (a.r.health_checked_at ?? 0) || b.score - a.score;
    },
  };
  scored.sort(by[sort]);
  const page = scored.slice(offset, offset + limit);
  cached(c, 60);
  return c.json({
    results: page.map((s) => summary(s.r)),
    total: scored.length,
    // Search looks at the best 200 matches (1000 without q); total stops there.
    total_capped: rows.length === (match ? 200 : 1000) || undefined,
    next_cursor: offset + limit < scored.length ? String(offset + limit) : undefined,
  });
});

// Guides are tools with kind = guide; this is a convenience alias for the website.
app.get("/guides", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/v1/tools";
  url.searchParams.set("kind", "guide");
  // Pass the execution context on: signed-in requests use it (waitUntil) while authenticating.
  return app.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});

app.get("/tools/:ns/:name", async (c) => {
  const { ns, name } = c.req.param();
  const { row, movedTo } = await findTool(c.env.DB, ns, name);
  if (!row) return notFound(c.env.DB, ns, name);
  // What the latest version's smoke test produced, when the scanner recorded it: the tool page shows it as real output.
  const smoke = await c.env.DB.prepare(`SELECT summary_json, ran_at FROM scans WHERE version_id = ? AND kind = 'smoke' AND result = 'pass' ORDER BY ran_at DESC LIMIT 1`)
    .bind(row.latest_version_id).first<{ summary_json: string | null; ran_at: number }>();
  const sampleJson = smoke?.summary_json ? JSON.parse(smoke.summary_json)?.sample : undefined;
  // People who look after a community package besides its namespace: who submitted it, and others staff added.
  const maintainers = (await c.env.DB.prepare(
    `SELECT COALESCE(u.handle, lower(u.login)) AS handle, m.reason FROM tool_maintainers m JOIN users u ON u.id = m.user_id
     WHERE m.tool_id = ? AND u.profile_hidden = 0 AND u.banned_at IS NULL ORDER BY m.created_at`,
  ).bind(row.id).all<{ handle: string; reason: string }>()).results;
  // What the upstream watcher last found, for community wrappers.
  const watch = await c.env.DB.prepare(`SELECT * FROM upstream_watch WHERE tool_id = ?`).bind(row.id).first<WatchRow>();
  const bump = watch ? await openBumpFor(c.env, row.id) : null;
  cached(c, 60);
  return c.json({
    ...summary(row),
    upstream: watch ? { ...publicWatch(watch), bump: bump ? { version: bump.version, number: bump.pr_number, url: bump.url } : undefined } : undefined,
    packaged_by: maintainers.find((m) => m.reason === "submitter")?.handle ?? undefined,
    maintainers: maintainers.length ? maintainers.map((m) => m.handle) : undefined,
    sample: sampleJson ? { ...sampleJson, version: row.latest_version, recorded_at: smoke!.ran_at } : undefined,
    deprecated_replacement: row.deprecated_replacement ?? undefined,
    repo_url: row.repo_url,
    // How the latest version came in; "direct" packages have no repository (repo_url is null).
    published_via: await publishedVia(c.env.DB, row.latest_version_id),
    homepage: JSON.parse(row.manifest_json).homepage ?? null,
    license: JSON.parse(row.manifest_json).license,
    deprecated_message: row.deprecated_message ?? undefined,
    manifest: JSON.parse(row.manifest_json),
    moved_to: movedTo,
    // Open issues people filed (the full status line is GET /tools/:ns/:name/status).
    community: { open_broken: row.open_broken ?? 0, open_outdated: row.open_outdated ?? 0 },
  });
});

app.get("/tools/:ns/:name/versions", async (c) => {
  const { ns, name } = c.req.param();
  const { row } = await findTool(c.env.DB, ns, name);
  if (!row) return notFound(c.env.DB, ns, name);
  const versions = await c.env.DB.prepare(
    `SELECT id, version, status, scan_status, published_at, yanked_at, signer_identity IS NOT NULL AS signed, changelog, changelog_source, git_sha
     FROM versions WHERE tool_id = ? AND status IN ('published', 'yanked', 'removed')
     ORDER BY semver_major DESC, semver_minor DESC, semver_patch DESC, semver_pre = '' DESC, semver_pre DESC`,
  )
    .bind(row.id)
    .all<{ id: string; status: string; published_at: number | null; [k: string]: any }>();
  // What people said about versions still in their first week.
  const firstWeek = await firstWeekCounts(c.env.DB, versions.results.filter((v) => v.status !== "removed"));
  cached(c, 60);
  return c.json({
    versions: versions.results.map(({ id, git_sha, changelog, changelog_source, ...v }) => ({
      ...v,
      signed: v.signed === 1 && row.manifest_mode !== "registry",
      // A removed version's notes go with it.
      ...releaseNotes(v.status === "removed" ? null : changelog, changelog_source, row.repo_url, git_sha),
      ...(firstWeek.has(id) ? { first_week: firstWeek.get(id) } : {}),
    })),
  });
});

/** A version's release notes as served: the Markdown (untrusted text: show it as text), sanitized HTML, and where they came from. */
function releaseNotes(changelog: string | null, source: string | null, repoUrl: string | null, sha: string | null) {
  if (!changelog) return { changelog: null, changelog_html: null, changelog_source: null };
  return { changelog, changelog_html: renderNotes(changelog, repoUrl, sha), changelog_source: source ?? "release" };
}

// What the install endpoint serves: a manifest every released ot accepts, and the whole one when that leaves fields out.
function installManifest(m: Record<string, any>) {
  const compat = compatManifest(m);
  return compat ? { manifest: compat, manifest_full: m } : { manifest: m };
}

app.get("/tools/:ns/:name/:version/manifest", async (c) => {
  const { ns, name, version } = c.req.param();
  const { row, movedTo } = await findTool(c.env.DB, ns, name);
  if (!row) return notFound(c.env.DB, ns, name);
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
    health_checked_at: row.health_checked_at ?? null,
    verified_publisher: row.verified === 1,
    source_unavailable: row.source_status === "unavailable",
    moved_to: movedTo,
    ...(removed ? { manifest: null } : installManifest(JSON.parse(v.manifest_json))),
    // Where ot retries when the original registry refuses (403, 404, denied): the same digest on the mirror,
    // and the registry's copy of the wheel. Only for OSI-approved licenses.
    ...(removed ? {} : await installFallbacks(c.env, v.id, row.namespace, row.name, v.version)),
  });
});

// Scan and check results for the security page. Personal-data hits are for reviewers only: the public sees
// whether the check passed, not the lines it flagged.
app.get("/tools/:ns/:name/:version/scans", async (c) => {
  const { ns, name, version } = c.req.param();
  const { row } = await findTool(c.env.DB, ns, name);
  if (!row) return notFound(c.env.DB, ns, name);
  const v = await findVersion(c.env.DB, row.id, version);
  if (!v || v.status === "removed") apiError(404, "version_not_found", `${ns}/${name} has no version ${version}`);
  const scans = await c.env.DB.prepare(`SELECT kind, result, summary_json, ran_at FROM scans WHERE version_id = ? ORDER BY ran_at, kind`)
    .bind(v.id).all<{ kind: string; result: string; summary_json: string | null; ran_at: number }>();
  cached(c, 300);
  return c.json({
    ref: `${row.namespace}/${row.name}`,
    version: v.version,
    scan_status: v.scan_status,
    signed: !!v.signer_identity && row.manifest_mode !== "registry",
    signer_identity: v.signer_identity ?? undefined,
    signer_issuer: v.signer_issuer ?? undefined,
    scans: scans.results.map((s) => {
      const summary = JSON.parse(s.summary_json ?? "null");
      return { kind: s.kind, result: s.result, ran_at: s.ran_at, summary: s.kind === "pii" ? { hits: summary?.hits?.length ?? 0 } : summary };
    }),
  });
});

app.get("/tools/:ns/:name/:version", async (c) => {
  const { ns, name, version } = c.req.param();
  const { row } = await findTool(c.env.DB, ns, name);
  if (!row) return notFound(c.env.DB, ns, name);
  const v = await findVersion(c.env.DB, row.id, version);
  if (!v || v.status === "removed") apiError(404, "version_not_found", `${ns}/${name} has no version ${version}`);
  // Notes are read separately so findVersion, which installs use, stays lean.
  const notes = await c.env.DB.prepare(`SELECT changelog, changelog_source, git_sha FROM versions WHERE id = ?`)
    .bind(v.id).first<{ changelog: string | null; changelog_source: string | null; git_sha: string | null }>();
  cached(c, 3600);
  return c.json({
    ref: `${row.namespace}/${row.name}`,
    version: v.version,
    status: v.status,
    published_at: v.published_at,
    scan_status: v.scan_status,
    signed: !!v.signer_identity && row.manifest_mode !== "registry",
    published_via: await publishedVia(c.env.DB, v.id),
    manifest: JSON.parse(v.manifest_json),
    ...releaseNotes(notes?.changelog ?? null, notes?.changelog_source ?? null, row.repo_url, notes?.git_sha ?? null),
  });
});

// Tools whose inputs accept the given output types, for chaining results into the next lookup.
// How many visible packages each facet value matches, for the site's filter rail. Counts are over tools (or
// guides with kind=guide) and ignore other filters, so they describe the catalogue, not the current search.
app.get("/facets", async (c) => {
  const kind = oneOf(c.req.query("kind"), ["tool", "guide"], "kind") ?? "tool";
  const base = `FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id WHERE ${VISIBLE} AND ${LISTED} AND t.kind = ?`;
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT io.type AS k, COUNT(DISTINCT t.id) AS n FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id JOIN tool_io io ON io.tool_id = t.id AND io.direction = 'in' WHERE ${VISIBLE} AND ${LISTED} AND t.kind = ? GROUP BY io.type`).bind(kind),
    c.env.DB.prepare(`SELECT io.type AS k, COUNT(DISTINCT t.id) AS n FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id JOIN tool_io io ON io.tool_id = t.id AND io.direction = 'out' WHERE ${VISIBLE} AND ${LISTED} AND t.kind = ? GROUP BY io.type`).bind(kind),
    c.env.DB.prepare(`SELECT j.value AS k, COUNT(DISTINCT t.id) AS n FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id, json_each(t.categories) j WHERE ${VISIBLE} AND ${LISTED} AND t.kind = ? GROUP BY j.value`).bind(kind),
    c.env.DB.prepare(`SELECT v.runtime_kind AS k, COUNT(*) AS n ${base} GROUP BY v.runtime_kind`).bind(kind),
    c.env.DB.prepare(`SELECT 'no_keys' AS k, COUNT(*) AS n ${base} AND NOT EXISTS (SELECT 1 FROM tool_secrets WHERE tool_id = t.id AND required = 1)`).bind(kind),
  ]);
  const counts = (i: number) => Object.fromEntries(((res[i]?.results ?? []) as { k: string | null; n: number }[]).filter((x) => x.k).map((x) => [x.k as string, x.n]));
  cached(c, 600);
  return c.json({ kind, inputs: counts(0), outputs: counts(1), categories: counts(2), runtimes: counts(3), no_keys: ((res[4]?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0 });
});

// What changed across the registry, newest first: releases, yanks, deprecations and transfers. The site's feeds and
// "What's new" page read it with fixed parameters, so a few cache entries serve everyone.
app.get("/activity", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30) || 30, 1), 100);
  const beforeRaw = c.req.query("before");
  const before = beforeRaw === undefined ? undefined : Number(beforeRaw);
  if (before !== undefined && (!Number.isInteger(before) || before <= 0)) apiError(400, "invalid_parameter", "before must be a Unix time in milliseconds");
  const kind = oneOf(c.req.query("kind"), ["tool", "guide"], "kind") as "tool" | "guide" | undefined;
  const input = oneOf(c.req.query("input"), INPUT_TYPES, "input");
  const namespace = c.req.query("namespace") || undefined;
  if (namespace !== undefined && !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(namespace)) apiError(400, "invalid_parameter", "namespace must be a namespace name");
  const events = oneOf(c.req.query("events"), ["registry", "community", "all"], "events") as "registry" | "community" | "all" | undefined;
  const result = await siteActivity(c.env.DB, { limit, before, kind, input, namespace, events });
  cached(c, 300);
  return c.json(result);
});

app.get("/pivots", async (c) => {
  const from = (c.req.query("from") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (from.length === 0) apiError(400, "invalid_parameter", "from must list one or more entity types");
  for (const t of from) oneOf(t, ENTITY_TYPES, "from");
  // Each entity type feeds the input types the pivot map gives it (a subdomain feeds domain inputs, an account
  // username and url inputs); types it gives none are listed as unmapped.
  const pivots: Record<string, ReturnType<typeof summary>[]> = {};
  const inputs: Record<string, string[]> = {};
  const unmapped: string[] = [];
  for (const type of from) {
    const targets = [...new Set((PIVOTS[type] ?? []).map((p) => p.input))];
    if (targets.length === 0) {
      unmapped.push(type);
      continue;
    }
    inputs[type] = targets;
    const rows = await c.env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM tools t JOIN namespaces n ON n.id = t.namespace_id
       JOIN versions v ON v.id = t.latest_version_id
       WHERE ${VISIBLE} AND ${LISTED} AND t.kind = 'tool' AND t.health_status != 'broken'
       AND EXISTS (SELECT 1 FROM tool_io WHERE tool_id = t.id AND direction = 'in' AND type IN (${targets.map(() => "?").join(", ")}))`,
    )
      .bind(...targets)
      .all<SummaryRow>();
    if (rows.results.length === 0) continue;
    pivots[type] = rows.results
      .map((r) => ({ r, s: rank(rankInput(r)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => summary(x.r));
  }
  cached(c, 600);
  return c.json({ pivots, inputs, unmapped });
});

// Anonymous install counts: no IP, user or token is stored, only a per-day counter.
app.post("/installs", async (c) => {
  const body = await c.req.json<{ tool?: string; version?: string; client?: string }>().catch(() => ({}) as { tool?: string; version?: string; client?: string });
  const [ns, name] = (body.tool ?? "").split("/");
  if (!ns || !name || !body.version) apiError(400, "invalid_body", "send {tool: 'namespace/name', version}");
  const v = await c.env.DB.prepare(
    `SELECT t.id AS tool_id, v.id AS version_id FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     JOIN versions v ON v.tool_id = t.id WHERE n.name = ? AND t.name = ? AND v.version = ? AND v.status = 'published'`,
  )
    .bind(ns, name, body.version)
    .first<{ tool_id: string; version_id: string }>();
  if (!v) return c.body(null, 204);
  // One count per address, package version and day, so a looping script or agent can't inflate ranking. The
  // address is only hashed into the rate-limit key and never stored.
  const ip = c.req.header("cf-connecting-ip");
  if (ip && (await overLimit(c.env, "install", `${ip}|${v.version_id}`, 1, 86_400_000))) return c.body(null, 204);
  const day = new Date().toISOString().slice(0, 10);
  const client = ["cli", "mcp", "ci"].includes(body.client ?? "") ? body.client! : "other";
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO install_counts (tool_id, version_id, day, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (tool_id, version_id, day) DO UPDATE SET count = count + 1`,
    ).bind(v.tool_id, v.version_id, day),
    c.env.DB.prepare(
      `INSERT INTO install_clients (day, client, count) VALUES (?, ?, 1) ON CONFLICT (day, client) DO UPDATE SET count = count + 1`,
    ).bind(day, client),
  ]);
  return c.body(null, 204);
});

// The remote MCP server (src/mcp.ts). Its tools read the public API as an anonymous visitor would, through the
// edge cache, with none of the caller's headers.
async function remoteMcp(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const get = (path: string) => {
    const inner = new Request(new URL(path, url.origin));
    return edgeCached(inner, env, ctx, async () => app.fetch(inner, env, ctx));
  };
  try {
    return await mcpEndpoint(req, get);
  } catch (err) {
    const requestId = req.headers.get("cf-ray") ?? ulid();
    ctx.waitUntil(reportError(env, err, { requestId, method: req.method, path: url.pathname }));
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `internal error (request ${requestId})` } }, { status: 500 });
  }
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return remoteMcp(req, url, env, ctx);
    return edgeCached(req, env, ctx, async () => app.fetch(req, env, ctx));
  },
  queue: (batch: MessageBatch<PublishMessage>, env: Env) => handleBatch(batch, env),
  async scheduled(event: ScheduledController, env: Env) {
    // Every 15 minutes: close scans that never reported back, and poll sources that are due.
    await expireStaleScans(env);
    await pollDueSources(env);
    // Publisher profiles from GitHub and GitLab: never synced, or older than 6 hours.
    await refreshDueProfiles(env);
    await alertStuckJobs(env);
    await expireRuns(env);
    await expireDrills(env);
    // Published versions without an image or wheel backup (older than backups, or failed) get one.
    await backfillBackups(env);
    // Community emails people asked to get at once (grouped per person since the last run).
    await deliverInbox(env, "immediate");
    // Weekly (Mondays): a git backup of every active source, for code pushed between releases.
    if (event.cron === WEEKLY_BACKUP_CRON) await weeklyBackups(env);
    // Monthly: restore a random bundle into an empty repository and pull a mirrored image by digest.
    if (event.cron === RESTORE_DRILL_CRON) await startDrill(env);
    // Nightly: recompute 30-day install totals that ranking uses, and re-check guides' links.
    if (event.cron === "17 3 * * *") {
      await queueNightlyLinkChecks(env);
      await dailyDigest(env);
      await purgeRateLimits(env);
      await purgeBackups(env);
      await lockStaleThreads(env);
      await deliverInbox(env, "daily");
      await purgeInbox(env);
      await refreshContributorStats(env);
      await queueUpstreamChecks(env);
      await purgeIdleNamespaces(env);
      // Images publishers pushed to the mirror that no version uses, and unfinished uploads.
      await queueMirrorSweeps(env);
      await env.DB.prepare(
        `UPDATE tools SET installs_30d = COALESCE((SELECT SUM(count) FROM install_counts
           WHERE tool_id = tools.id AND day >= date('now', '-30 days')), 0)`,
      ).run();
    }
  },
} satisfies ExportedHandler<Env, PublishMessage>;

export { app };
