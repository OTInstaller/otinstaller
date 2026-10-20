// Guides and tool docs on the publishing pipeline. Every release's README and pages are rendered while it
// is validated and stored in R2. Guides then get content checks instead of a security scan: every external
// link is fetched (dead links warn; links Cloudflare URL Scanner calls malicious reject the release), and
// pages are searched for personal data, which sends the release to a reviewer. Links are checked again
// nightly, and a guide with more than 20% dead links is marked "Needs update".
import { deps, type Env } from "./env";
import { ulid } from "./lib/crypto";
import { cleanImage, kindForPath, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES, sniff, CONTENT_TYPES, type ImageKind } from "./lib/images";
import type { RepoHost } from "./hosts/repo";
import type { Manifest, Problem } from "./lib/manifest";
import { findPersonalData, pageProblems, renderPage, type PiiHit, type Rendered } from "./content";
import { commitStatus, loadVersion, publishVersion, SCAN_TOKEN_TTL } from "./scans";
import { audit } from "./routes/auth";
import { ownerEmails, sendEmail, templates } from "./notify";

export const LINK_CHECK_LIMIT = 300;
export const NEEDS_UPDATE_RATIO = 0.2;
const LINK_TIMEOUT_MS = 10_000;
const LINK_CONCURRENCY = 6;
const URLSCAN_HOSTS = 20;
const URLSCAN_ROUNDS = 5;
const SEARCH_TEXT_PER_PAGE = 20_000;
const SEARCH_TEXT_MAX = 200_000;
const CF_API = "https://api.cloudflare.com/client/v4/accounts";

// ---------- rendering at validation ----------

export interface RenderedPage {
  path: string;
  md: string;
  rendered: Rendered;
}

export interface RenderedRelease {
  pages: RenderedPage[];
  readme: Rendered | null;
  problems: Problem[];
  /** Cleaned images to store in R2, filled in by copyImages. */
  images?: StoredImage[];
}

export interface StoredImage {
  key: string;
  kind: ImageKind;
  bytes: Uint8Array;
}

/** Where readers see a guide page or a tool's docs page on the website. */
export function pageUrl(env: Env, m: Manifest, path: string): string {
  const slug = path.replace(/\.md$/i, "");
  return m.kind === "guide"
    ? `${env.SITE_URL}/guides/${m.namespace}/${m.name}/${m.version}/${slug}`
    : `${env.SITE_URL}/tools/${m.namespace}/${m.name}/docs/${slug}`;
}

/** A file in the repository at the released commit, for images and other links into the repository. */
export function rawFileUrl(provider: "github" | "gitlab", repo: string, sha: string, path: string): string {
  const p = path.split("/").map(encodeURIComponent).join("/");
  return provider === "github" ? `https://raw.githubusercontent.com/${repo}/${sha}/${p}` : `https://gitlab.com/${repo}/-/raw/${sha}/${p}`;
}

/**
 * Renders a release's README and its guide content or tool docs, and applies the content rules. `files`
 * holds every file the manifest refers to, keyed by repository path.
 */
export function renderRelease(
  env: Env, m: Manifest, files: Map<string, string>, src: { provider: "github" | "gitlab"; repo: string; sha: string }, assets?: Map<string, string>,
): RenderedRelease {
  const pagesDef = m.kind === "guide" ? m.content : m.docs;
  const nav = new Set(pagesDef?.nav ?? []);
  const fileUrl = (p: string) => rawFileUrl(src.provider, src.repo, src.sha, p);
  const imageUrl = (p: string) => assets?.get(p) ?? null;
  const problems: Problem[] = [];
  const pages: RenderedPage[] = [];
  for (const path of pagesDef?.nav ?? []) {
    const file = pagesDef!.root + path;
    const md = files.get(file);
    if (md === undefined) continue;
    const rendered = renderPage(md, { file, root: pagesDef!.root, pages: nav, pageUrl: (p) => pageUrl(env, m, p), fileUrl, imageUrl });
    problems.push(...pageProblems(file, md, rendered));
    pages.push({ path, md, rendered });
  }
  let readme: Rendered | null = null;
  const readmeMd = m.readme ? files.get(m.readme) : undefined;
  if (m.readme && readmeMd !== undefined) {
    readme = renderPage(readmeMd, {
      file: m.readme, root: pagesDef?.root ?? "", pages: nav, pageUrl: (p) => pageUrl(env, m, p), fileUrl, imageUrl, strict: false, allowHtml: true,
    });
    // READMEs are rendered (raw HTML shown as text) but the content rules are for guide pages and docs only.
  }
  return { pages, readme, problems };
}

/**
 * Copies the images a release's pages show into the registry: checked by content, at most 2 MB each and
 * 50 MB per version, with metadata removed (SVGs sanitized). Returns where each one is served from.
 * README images are copied when they pass and otherwise left at the repository, without problems.
 */
export async function copyImages(env: Env, host: RepoHost, sha: string, content: RenderedRelease): Promise<{ assets: Map<string, string>; images: StoredImage[]; problems: Problem[] }> {
  const strict = new Set(content.pages.flatMap((p) => p.rendered.images));
  const all = [...strict, ...(content.readme?.images ?? []).filter((p) => !strict.has(p))];
  const assets = new Map<string, string>();
  const images: StoredImage[] = [];
  const problems: Problem[] = [];
  let total = 0;
  for (const path of all) {
    const fail = (code: string, message: string, hint?: string) => strict.has(path) && problems.push({ code, path, message, hint });
    const raw = await host.fileBytes(path, sha);
    if (raw === null) {
      fail("manifest_file_missing", `image ${path} does not exist at this release`);
      continue;
    }
    if (raw.length > MAX_IMAGE_BYTES) {
      fail("content_image_too_large", `${path} is ${(raw.length / 1048576).toFixed(1)} MB; images can be at most 2 MB`, "resize or compress it");
      continue;
    }
    const kind = sniff(raw);
    const named = kindForPath(path);
    if (!kind || kind !== named) {
      fail("content_image_type", `${path} is not the ${named ?? "image"} file its name says`, "keep images in the repository as .png, .jpg, .webp or .svg");
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = cleanImage(kind, raw);
    } catch {
      fail("content_image_type", `${path} could not be read as ${kind}`);
      continue;
    }
    total += bytes.length;
    if (total > MAX_IMAGES_BYTES) {
      fail("content_images_too_large", "the images of this version add up to more than 50 MB", "use fewer or smaller images");
      break;
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const key = `assets/${digest}.${kind === "jpeg" ? "jpg" : kind}`;
    assets.set(path, `${env.API_URL}/v1/${key}`);
    if (!images.some((i) => i.key === key)) images.push({ key, kind, bytes });
  }
  return { assets, images, problems };
}

/** A guide's related_tools must be published tools, so its tool links never rot silently. */
export async function relatedToolProblems(env: Env, m: Manifest): Promise<Problem[]> {
  const ps: Problem[] = [];
  for (const [i, ref] of (m.related_tools ?? []).entries()) {
    const [ns, name] = ref.split("/");
    const found = await env.DB.prepare(
      `SELECT 1 FROM tools t JOIN namespaces n ON n.id = t.namespace_id
       WHERE n.name = ? AND t.name = ? AND t.kind = 'tool' AND t.status != 'removed' AND n.status = 'active' AND t.latest_version_id IS NOT NULL`,
    ).bind(ns, name).first();
    if (!found) {
      ps.push({ code: "guide_related_tool_unknown", path: `/related_tools/${i}`, message: `${ref} is not a published tool in the registry`, hint: "list tools as namespace/name; publish the tool first" });
    }
  }
  return ps;
}

const EXAMPLE_HOST = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$|^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

function isExampleUrl(url: string): boolean {
  try {
    return EXAMPLE_HOST.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

export const contentKey = (versionId: string, path: string) => `content/${versionId}/${path}`;
export const readmeKey = (versionId: string) => `readme/${versionId}.html`;

/** Stores rendered pages in R2 and their navigation, table of contents and links in D1. */
export async function storeContent(env: Env, versionId: string, m: Manifest, content: RenderedRelease) {
  const db = env.DB;
  const now = Date.now();
  // Images are content-addressed, so versions share them and an existing one is never written again.
  for (const img of content.images ?? []) {
    if (await env.CONTENT.head(img.key)) continue;
    await env.CONTENT.put(img.key, img.bytes, { httpMetadata: { contentType: CONTENT_TYPES[img.kind] } });
  }
  for (const p of content.pages) {
    await env.CONTENT.put(contentKey(versionId, p.path), p.md, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    await env.CONTENT.put(`${contentKey(versionId, p.path)}.html`, p.rendered.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  }
  if (content.readme) {
    await env.CONTENT.put(readmeKey(versionId), content.readme.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  }
  // A re-tagged rejected version replaces what its earlier attempt stored.
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM pages WHERE version_id = ?`).bind(versionId),
    db.prepare(`DELETE FROM page_links WHERE version_id = ?`).bind(versionId),
  ];
  content.pages.forEach((p, i) => {
    stmts.push(db.prepare(
      `INSERT INTO pages (id, version_id, path, title, position, r2_key, word_count, dead_links, toc_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(now), versionId, p.path, p.rendered.title, i, contentKey(versionId, p.path), p.rendered.words,
      p.rendered.links.filter((l) => l.missing).length, JSON.stringify(p.rendered.toc)));
    // Tool docs are not link-checked; only guides are.
    if (m.kind !== "guide") return;
    for (const l of p.rendered.links) {
      const status = l.missing ? "missing" : isExampleUrl(l.url) ? "skipped" : "pending";
      stmts.push(db.prepare(`INSERT INTO page_links (id, version_id, page_path, url, line, status) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(ulid(now), versionId, p.path, l.url, l.line, status));
    }
  });
  const text = m.kind === "guide"
    ? content.pages.map((p) => p.rendered.text.slice(0, SEARCH_TEXT_PER_PAGE)).join("\n").slice(0, SEARCH_TEXT_MAX)
    : (content.readme?.text ?? "").slice(0, SEARCH_TEXT_PER_PAGE);
  stmts.push(db.prepare(`UPDATE versions SET search_text = ? WHERE id = ?`).bind(text, versionId));
  await db.batch(stmts);
}

/** Starts a guide's content checks: the guide's equivalent of dispatching a security scan. */
export async function queueContentChecks(env: Env, versionId: string) {
  const now = Date.now();
  // The expiry lets expireStaleScans reject a check that never finishes, as it does for scans.
  await env.DB.prepare(`UPDATE versions SET scan_dispatched_at = ?, scan_token_expires_at = ? WHERE id = ?`).bind(now, now + SCAN_TOKEN_TTL, versionId).run();
  await env.PUBLISH_QUEUE.send({ checkVersionId: versionId });
}

// ---------- link checks ----------

type LinkResult = { status: "ok" | "dead"; http: number | null };

/** Fetches a link the way a reader's browser would. Sites that refuse bots (401, 403, 429) count as alive. */
export async function checkUrl(url: string): Promise<LinkResult> {
  const probe = (method: string) =>
    deps.fetch(url, {
      method, redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      headers: { "User-Agent": "otinstaller-link-check (+https://otinstaller.com/docs/guides#link-checks)" },
    });
  try {
    let res = await probe("HEAD");
    if ([400, 403, 405, 501].includes(res.status)) {
      res = await probe("GET");
      await res.body?.cancel();
    }
    if (res.status < 400 || [401, 403, 429].includes(res.status)) return { status: "ok", http: res.status };
    return { status: "dead", http: res.status };
  } catch {
    return { status: "dead", http: null };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** Checks a version's pending links, each distinct URL once, up to LINK_CHECK_LIMIT. */
export async function checkPendingLinks(env: Env, versionId: string) {
  const db = env.DB;
  const urls = (await db.prepare(`SELECT DISTINCT url FROM page_links WHERE version_id = ? AND status = 'pending' ORDER BY url`)
    .bind(versionId).all<{ url: string }>()).results.map((r) => r.url);
  const checked = urls.slice(0, LINK_CHECK_LIMIT);
  const results = await pool(checked, LINK_CONCURRENCY, checkUrl);
  const now = Date.now();
  const stmts = checked.map((url, i) =>
    db.prepare(`UPDATE page_links SET status = ?, http_status = ?, checked_at = ? WHERE version_id = ? AND url = ? AND status = 'pending'`)
      .bind(results[i]!.status, results[i]!.http, now, versionId, url));
  stmts.push(db.prepare(`UPDATE page_links SET status = 'unchecked' WHERE version_id = ? AND status = 'pending'`).bind(versionId));
  await db.batch(stmts);
}

/** Recounts dead links per page after a check. */
async function countDeadLinks(env: Env, versionId: string) {
  await env.DB.prepare(
    `UPDATE pages SET dead_links = (SELECT COUNT(*) FROM page_links l WHERE l.version_id = pages.version_id AND l.page_path = pages.path
       AND l.status IN ('dead', 'missing', 'malicious')) WHERE version_id = ?`,
  ).bind(versionId).run();
}

/** Sets a guide's dead-link ratio and "Needs update" mark from its latest version. */
export async function updateLinkHealth(env: Env, toolId: string) {
  const r = await env.DB.prepare(
    `SELECT SUM(l.status IN ('dead', 'missing', 'malicious')) AS dead, SUM(l.status IN ('ok', 'dead', 'missing', 'malicious')) AS total
     FROM page_links l JOIN tools t ON t.latest_version_id = l.version_id WHERE t.id = ?`,
  ).bind(toolId).first<{ dead: number | null; total: number | null }>();
  const ratio = r?.total ? (r.dead ?? 0) / r.total : 0;
  await env.DB.prepare(`UPDATE tools SET dead_link_ratio = ?, needs_update = ? WHERE id = ?`).bind(ratio, ratio > NEEDS_UPDATE_RATIO ? 1 : 0, toolId).run();
}

// ---------- Cloudflare URL Scanner ----------

const urlscanConfigured = (env: Env) => !!env.CF_URLSCAN_ACCOUNT_ID && !!env.CF_URLSCAN_TOKEN;
const cfHeaders = (env: Env) => ({ Authorization: `Bearer ${env.CF_URLSCAN_TOKEN}`, "Content-Type": "application/json" });

// A link chosen for URL Scanner but not submitted yet (first round, or rate limited) carries this scan_error.
const QUEUED = "queued";

/** Chooses one link per external host (up to URLSCAN_HOSTS), preferring links that answered: a dead page says little about the site. */
async function chooseUrlScans(env: Env, versionId: string) {
  const rows = (await env.DB.prepare(
    `SELECT url FROM page_links WHERE version_id = ? AND status IN ('ok', 'dead') GROUP BY url ORDER BY MIN(status = 'dead'), url`,
  ).bind(versionId).all<{ url: string }>()).results;
  const byHost = new Map<string, string>();
  for (const { url } of rows) {
    const host = new URL(url).hostname;
    if (!byHost.has(host) && byHost.size < URLSCAN_HOSTS) byHost.set(host, url);
  }
  await env.DB.batch([...byHost.values()].map((url) =>
    env.DB.prepare(`UPDATE page_links SET scan_error = ? WHERE version_id = ? AND url = ?`).bind(QUEUED, versionId, url)));
}

/**
 * Submits the chosen links that are still queued. URL Scanner rate-limits submissions per account, so on a
 * 429 the rest wait for the next round; any other refusal is final and keeps the API's reason. Returns how
 * many still wait to be submitted.
 */
async function submitUrlScans(env: Env, versionId: string): Promise<number> {
  const queued = (await env.DB.prepare(`SELECT DISTINCT url FROM page_links WHERE version_id = ? AND scan_error = ? ORDER BY url`)
    .bind(versionId, QUEUED).all<{ url: string }>()).results;
  let waiting = queued.length;
  for (const { url } of queued) {
    const res = await deps.fetch(`${CF_API}/${env.CF_URLSCAN_ACCOUNT_ID}/urlscanner/v2/scan`, {
      method: "POST", headers: cfHeaders(env), body: JSON.stringify({ url, visibility: "Unlisted" }),
    });
    const body = (await res.json().catch(() => null)) as { uuid?: string; errors?: { message?: string }[]; message?: string } | null;
    if (res.status === 429) break;
    waiting--;
    const scanId = res.ok ? body?.uuid : undefined;
    const error = scanId ? null : `${res.status}: ${body?.errors?.map((e) => e.message).join("; ") || body?.message || "no scan ID returned"}`.slice(0, 300);
    if (error) console.error(`URL Scanner refused ${url}: ${error}`);
    await env.DB.prepare(`UPDATE page_links SET scan_id = ?, scan_verdict = ?, scan_error = ? WHERE version_id = ? AND url = ?`)
      .bind(scanId ?? null, scanId ? null : "unknown", error, versionId, url).run();
  }
  return waiting;
}

/** Collects finished URL Scanner results; returns how many are still running. */
async function collectUrlScans(env: Env, versionId: string): Promise<number> {
  const pending = (await env.DB.prepare(`SELECT DISTINCT url, scan_id FROM page_links WHERE version_id = ? AND scan_id IS NOT NULL AND scan_verdict IS NULL`)
    .bind(versionId).all<{ url: string; scan_id: string }>()).results;
  let running = 0;
  for (const p of pending) {
    const res = await deps.fetch(`${CF_API}/${env.CF_URLSCAN_ACCOUNT_ID}/urlscanner/v2/result/${encodeURIComponent(p.scan_id)}`, { headers: cfHeaders(env) });
    if (res.status === 404) {
      running++;
      continue;
    }
    let verdict = "unknown";
    if (res.ok) {
      const body = (await res.json()) as { verdicts?: { overall?: { malicious?: boolean } } };
      verdict = body.verdicts?.overall?.malicious ? "malicious" : "clean";
    }
    await env.DB.prepare(
      `UPDATE page_links SET scan_verdict = ?, status = CASE WHEN ? = 'malicious' THEN 'malicious' ELSE status END WHERE version_id = ? AND url = ?`,
    ).bind(verdict, verdict, versionId, p.url).run();
  }
  return running;
}

// ---------- the check step ----------

export interface CheckSummary {
  links: { checked: number; dead: number; missing: number; malicious: number; unchecked: number; skipped: number };
  dead_links: { page: string; line: number | null; url: string; status: string; http_status: number | null }[];
  url_scanner: "checked" | "not_configured";
  /** Each link sent to URL Scanner: its verdict (clean, malicious, unknown) and, if it was refused, why. */
  url_scans: { url: string; verdict: string; error: string | null }[];
  pii: PiiHit[];
}

/**
 * Runs a guide's content checks. The first round fetches every link and submits URL scans; later rounds
 * (a minute apart, through the queue) collect scan verdicts. Then the release is rejected, published, or
 * held for a reviewer.
 */
export async function runContentChecks(env: Env, versionId: string, attempt = 0): Promise<{ status: string; summary: CheckSummary } | null> {
  const v = await loadVersion(env, "v.id = ?", versionId);
  if (!v || v.status !== "scanning" || v.kind !== "guide") return null;
  const db = env.DB;
  const pages = (await db.prepare(`SELECT path, r2_key FROM pages WHERE version_id = ? ORDER BY position`).bind(versionId).all<{ path: string; r2_key: string }>()).results;
  if (pages.length === 0) throw new Error(`version ${versionId} has no stored pages`);

  const scanner = urlscanConfigured(env);
  if (attempt === 0) {
    await checkPendingLinks(env, versionId);
    if (scanner) await chooseUrlScans(env, versionId);
  }
  if (scanner) {
    const unsubmitted = await submitUrlScans(env, versionId);
    const running = await collectUrlScans(env, versionId);
    if (running + unsubmitted > 0 && attempt < URLSCAN_ROUNDS) {
      await env.PUBLISH_QUEUE.send({ checkVersionId: versionId, attempt: attempt + 1 }, { delaySeconds: 60 });
      return null;
    }
    // Scans that never finished, or never got past the rate limit, are not held against the author.
    await db.batch([
      db.prepare(`UPDATE page_links SET scan_verdict = 'unknown' WHERE version_id = ? AND scan_id IS NOT NULL AND scan_verdict IS NULL`).bind(versionId),
      db.prepare(`UPDATE page_links SET scan_verdict = 'unknown', scan_error = '429: still rate limited after ${URLSCAN_ROUNDS} rounds' WHERE version_id = ? AND scan_error = ?`)
        .bind(versionId, QUEUED),
    ]);
  }
  await countDeadLinks(env, versionId);

  const pii: PiiHit[] = [];
  for (const p of pages) {
    const obj = await env.CONTENT.get(p.r2_key);
    if (obj) pii.push(...findPersonalData(await obj.text(), p.path));
  }
  const links = (await db.prepare(`SELECT page_path, line, url, status, http_status FROM page_links WHERE version_id = ? ORDER BY page_path, line`)
    .bind(versionId).all<{ page_path: string; line: number | null; url: string; status: string; http_status: number | null }>()).results;
  const count = (s: string) => links.filter((l) => l.status === s).length;
  const summary: CheckSummary = {
    links: { checked: count("ok") + count("dead") + count("malicious"), dead: count("dead"), missing: count("missing"), malicious: count("malicious"), unchecked: count("unchecked"), skipped: count("skipped") },
    dead_links: links.filter((l) => ["dead", "missing", "malicious"].includes(l.status)).slice(0, 100)
      .map((l) => ({ page: l.page_path, line: l.line, url: l.url, status: l.status, http_status: l.http_status })),
    url_scanner: scanner ? "checked" : "not_configured",
    url_scans: (await db.prepare(
      `SELECT url, MAX(scan_verdict) AS verdict, MAX(scan_error) AS error FROM page_links WHERE version_id = ? AND scan_verdict IS NOT NULL GROUP BY url ORDER BY url`,
    ).bind(versionId).all<{ url: string; verdict: string; error: string | null }>()).results,
    pii,
  };
  return { status: await settle(env, v, summary), summary };
}

type Version = NonNullable<Awaited<ReturnType<typeof loadVersion>>>;

async function settle(env: Env, v: Version, s: CheckSummary): Promise<string> {
  const db = env.DB;
  const now = Date.now();
  const ref = `${v.namespace}/${v.name}`;
  const linkResult = s.links.malicious > 0 ? "fail" : s.links.dead + s.links.missing > 0 ? "warn" : "pass";
  const linkSummary = { ...s.links, dead_links: s.dead_links, url_scanner: s.url_scanner, url_scans: s.url_scans };
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO scans (id, version_id, kind, result, summary_json, ran_at) VALUES (?, ?, 'links', ?, ?, ?)`).bind(ulid(now), v.id, linkResult, JSON.stringify(linkSummary), now),
    db.prepare(`INSERT INTO scans (id, version_id, kind, result, summary_json, ran_at) VALUES (?, ?, 'pii', ?, ?, ?)`)
      .bind(ulid(now), v.id, s.pii.length ? "warn" : "pass", JSON.stringify({ hits: s.pii }), now),
    db.prepare(`UPDATE versions SET scan_token_expires_at = NULL WHERE id = ?`).bind(v.id),
  ];

  if (linkResult === "fail") {
    const bad = s.dead_links.find((l) => l.status === "malicious")!;
    const message = `${bad.url} (in ${bad.page}) is flagged as malicious by Cloudflare URL Scanner; remove the link`;
    stmts.push(
      db.prepare(`UPDATE versions SET status = 'rejected', scan_status = 'fail', rejected_reason = 'content_link_malicious' WHERE id = ?`).bind(v.id),
      db.prepare(`UPDATE publish_jobs SET status = 'rejected', error_code = 'content_link_malicious', error_detail = ?, updated_at = ? WHERE version_id = ?`).bind(message, now, v.id),
      audit(db, null, "system", "checks.rejected", "version", v.id, { code: "content_link_malicious", url: bad.url }),
    );
    await db.batch(stmts);
    await commitStatus(env, v, "failure", `content_link_malicious: ${message}`);
    await sendEmail(env, { to: await ownerEmails(env, v.namespace_id), kind: "rejected", key: `rejected:${v.id}`, ...templates.rejected(env, ref, v.version, "content_link_malicious", message) });
    return "rejected";
  }

  const result = linkResult === "warn" || s.pii.length ? "warn" : "pass";
  stmts.push(
    db.prepare(`UPDATE versions SET scan_status = ? WHERE id = ?`).bind(result, v.id),
    audit(db, null, "system", `checks.${result}`, "version", v.id, { dead: s.links.dead + s.links.missing, pii: s.pii.length }),
  );
  await db.batch(stmts);

  // Possible personal data always goes to a reviewer, even from an approved publisher.
  if (v.namespace_status === "active" && s.pii.length === 0) {
    await publishVersion(env, v.id);
    return "published";
  }
  await db.batch([
    db.prepare(`UPDATE versions SET status = 'awaiting_review' WHERE id = ?`).bind(v.id),
    db.prepare(`UPDATE publish_jobs SET status = 'awaiting_review', updated_at = ? WHERE version_id = ?`).bind(now, v.id),
  ]);
  await commitStatus(env, v, "pending", s.pii.length ? "Checks done; possible personal data awaits review" : "Checks passed; new publisher awaiting review");
  const mail = s.pii.length ? templates.contentReview(env, ref, v.version, s.pii.length) : templates.inReview(env, ref, v.version);
  await sendEmail(env, { to: await ownerEmails(env, v.namespace_id), kind: "in_review", key: `in_review:${v.id}`, ...mail });
  return "awaiting_review";
}

// ---------- nightly ----------

/** Queues a link check for every published guide. */
export async function queueNightlyLinkChecks(env: Env) {
  const guides = (await env.DB.prepare(
    `SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id
     WHERE t.kind = 'guide' AND t.status != 'removed' AND n.status = 'active' AND t.latest_version_id IS NOT NULL`,
  ).all<{ id: string }>()).results;
  for (let i = 0; i < guides.length; i += 100) {
    await env.PUBLISH_QUEUE.sendBatch(guides.slice(i, i + 100).map((g) => ({ body: { linkCheckToolId: g.id } })));
  }
  return guides.length;
}

/** Checks a guide's latest version's links again and updates its "Needs update" mark. */
export async function recheckLinks(env: Env, toolId: string) {
  const t = await env.DB.prepare(`SELECT latest_version_id FROM tools WHERE id = ? AND kind = 'guide'`).bind(toolId).first<{ latest_version_id: string | null }>();
  if (!t?.latest_version_id) return;
  await env.DB.prepare(`UPDATE page_links SET status = 'pending' WHERE version_id = ? AND status IN ('ok', 'dead', 'unchecked')`).bind(t.latest_version_id).run();
  await checkPendingLinks(env, t.latest_version_id);
  await countDeadLinks(env, t.latest_version_id);
  await updateLinkHealth(env, toolId);
}
