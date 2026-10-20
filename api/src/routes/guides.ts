// Public reads for guides, tool docs and rendered READMEs. Pages are served from R2 as HTML (for the
// website) or as the author's Markdown (for `ot guide read` and `ot docs`).
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { cached, findTool, findVersion, LISTED, summary, SUMMARY_COLUMNS, VISIBLE, type SummaryRow, type ToolRow, type VersionRow } from "../catalog";
import { readmeKey } from "../guides";
import type { Manifest } from "../lib/manifest";
import { imageHeaders, kindForPath } from "../lib/images";

type PageRow = { path: string; title: string; position: number; r2_key: string; word_count: number; dead_links: number; toc_json: string | null };

async function pagesOf(db: D1Database, versionId: string): Promise<PageRow[]> {
  return (await db.prepare(`SELECT path, title, position, r2_key, word_count, dead_links, toc_json FROM pages WHERE version_id = ? ORDER BY position`)
    .bind(versionId).all<PageRow>()).results;
}

const navEntry = (p: PageRow) => ({ path: p.path, title: p.title, words: p.word_count, dead_links: p.dead_links });

async function guideRow(c: Context<AppEnv>): Promise<{ row: ToolRow; movedTo?: string }> {
  const { ns, name } = c.req.param() as { ns: string; name: string };
  const { row, movedTo } = await findTool(c.env.DB, ns, name);
  if (!row || row.kind !== "guide") apiError(404, "guide_not_found", `${ns}/${name} is not a guide in the registry`);
  return { row, movedTo };
}

async function guideVersion(c: Context<AppEnv>, row: ToolRow, version: string): Promise<VersionRow> {
  const v = await findVersion(c.env.DB, row.id, version);
  if (!v || v.status === "removed") apiError(404, "version_not_found", `${row.namespace}/${row.name} has no version ${version}`);
  return v;
}

/** The tools a guide lists, with what the site and `ot guide tools` need to install them. */
async function relatedTools(db: D1Database, refs: string[]) {
  const out = [];
  for (const ref of refs) {
    const [ns, name] = ref.split("/");
    const r = await db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id
       WHERE n.name = ? AND t.name = ? AND t.kind = 'tool' AND ${VISIBLE}`,
    ).bind(ns, name).first<SummaryRow>();
    out.push(r ? { ref, available: true, install: `ot install ${ref}`, ...summary(r) } : { ref, available: false });
  }
  return out;
}

/** Resolves a page by path, path without ".md", or 1-based position. */
function pickPage(pages: PageRow[], wanted: string): PageRow | undefined {
  const p = decodeURIComponent(wanted).replace(/^\/+/, "");
  return pages.find((x) => x.path === p) ?? pages.find((x) => x.path === `${p}.md`) ?? (/^\d+$/.test(p) ? pages[Number(p) - 1] : undefined);
}

async function servePage(c: Context<AppEnv>, ref: string, version: string, versionId: string, wanted: string, maxAge: number) {
  const format = c.req.query("format") ?? "html";
  if (format !== "html" && format !== "md") apiError(400, "invalid_parameter", "format must be html or md");
  const pages = await pagesOf(c.env.DB, versionId);
  const page = pickPage(pages, wanted);
  if (!page) apiError(404, "page_not_found", `${ref}@${version} has no page ${wanted}`);
  const obj = await c.env.CONTENT.get(format === "md" ? page.r2_key : `${page.r2_key}.html`);
  if (!obj) apiError(404, "page_not_rendered", `${ref}@${version} ${page.path} has not been rendered`);
  const at = pages.indexOf(page);
  const near = (p: PageRow | undefined) => (p ? { path: p.path, title: p.title } : null);
  cached(c, maxAge);
  return c.json({
    ref, version, path: page.path, title: page.title, position: page.position + 1, pages: pages.length, format,
    body: await obj.text(), toc: JSON.parse(page.toc_json ?? "[]"), prev: near(pages[at - 1]), next: near(pages[at + 1]),
  });
}

export function guideRoutes(app: App) {
  const detail = async (c: Context<AppEnv>, version: string) => {
    const { row, movedTo } = await guideRow(c);
    const v = await guideVersion(c, row, version);
    const m = JSON.parse(v.manifest_json) as Manifest;
    const links = await c.env.DB.prepare(`SELECT summary_json FROM scans WHERE version_id = ? AND kind = 'links' ORDER BY ran_at DESC LIMIT 1`)
      .bind(v.id).first<{ summary_json: string }>();
    const ref = `${row.namespace}/${row.name}`;
    cached(c, version === "latest" ? 60 : 3600);
    return c.json({
      ...summary(row),
      ref, version: v.version, status: v.status, published_at: v.published_at, moved_to: movedTo,
      title: m.title, level: m.level, format: m.format, language: m.language ?? "en", license: m.license, topics: m.topics ?? [],
      repo_url: row.repo_url, homepage: m.homepage ?? null,
      nav: (await pagesOf(c.env.DB, v.id)).map(navEntry),
      related_tools: await relatedTools(c.env.DB, m.related_tools ?? []),
      checks: {
        // The nightly check updates the latest version's mark; older versions show what was found at publish.
        needs_update: v.id === row.latest_version_id && row.needs_update === 1,
        dead_link_ratio: v.id === row.latest_version_id ? row.dead_link_ratio : null,
        links: links ? JSON.parse(links.summary_json) : null,
      },
      manifest: m,
    });
  };
  app.get("/guides/:ns/:name", (c) => detail(c, "latest"));
  app.get("/guides/:ns/:name/:version", (c) => detail(c, c.req.param("version")));

  app.get("/guides/:ns/:name/:version/pages/:path{.+}", async (c) => {
    const { row } = await guideRow(c);
    const version = c.req.param("version");
    const v = await guideVersion(c, row, version);
    return servePage(c, `${row.namespace}/${row.name}`, v.version, v.id, c.req.param("path"), version === "latest" ? 60 : 3600);
  });

  // Images from guides, docs and READMEs, copied at publish with their metadata removed. Content-addressed,
  // so they never change.
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    const kind = kindForPath(file);
    if (!/^[0-9a-f]{64}\.(png|jpg|webp|svg)$/.test(file) || !kind) apiError(404, "asset_not_found", "no such image");
    const obj = await c.env.CONTENT.get(`assets/${file}`);
    if (!obj) apiError(404, "asset_not_found", "no such image");
    return new Response(obj.body, { headers: imageHeaders(kind) });
  });

  // ---------- tool docs, guides using a tool, README ----------

  const toolRow = async (c: Context<AppEnv>) => {
    const { ns, name } = c.req.param() as { ns: string; name: string };
    const { row } = await findTool(c.env.DB, ns, name);
    if (!row) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
    return row;
  };

  app.get("/tools/:ns/:name/docs", async (c) => {
    const row = await toolRow(c);
    const pages = row.kind === "tool" ? await pagesOf(c.env.DB, row.latest_version_id) : [];
    if (pages.length === 0) apiError(404, "docs_not_found", `${row.namespace}/${row.name} ships no docs`, "tools add docs with the docs: field in otinstaller.yaml");
    cached(c, 600);
    return c.json({ ref: `${row.namespace}/${row.name}`, version: row.latest_version, nav: pages.map(navEntry) });
  });

  app.get("/tools/:ns/:name/docs/:path{.+}", async (c) => {
    const row = await toolRow(c);
    if (row.kind !== "tool") apiError(404, "docs_not_found", `${row.namespace}/${row.name} is a guide; read it with /guides`);
    return servePage(c, `${row.namespace}/${row.name}`, row.latest_version, row.latest_version_id, c.req.param("path"), 600);
  });

  app.get("/tools/:ns/:name/guides", async (c) => {
    const row = await toolRow(c);
    const guides = await c.env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM tool_guides g JOIN tools t ON t.id = g.guide_id JOIN namespaces n ON n.id = t.namespace_id
       JOIN versions v ON v.id = t.latest_version_id WHERE g.tool_id = ? AND ${VISIBLE} AND ${LISTED} ORDER BY t.stars_count DESC, t.name`,
    ).bind(row.id).all<SummaryRow>();
    cached(c, 600);
    return c.json({ guides: guides.results.map(summary) });
  });

  app.get("/tools/:ns/:name/readme", async (c) => {
    const row = await toolRow(c);
    const obj = await c.env.CONTENT.get(readmeKey(row.latest_version_id));
    if (!obj) apiError(404, "readme_not_found", `${row.namespace}/${row.name} has no rendered README`);
    cached(c, 600);
    return c.json({ ref: `${row.namespace}/${row.name}`, version: row.latest_version, html: await obj.text() });
  });
}
