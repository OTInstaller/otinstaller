// The import wizard's endpoints, and editing or moving a registry-held manifest.
import { HTTPException } from "hono/http-exception";
import { deps, type App, type Env } from "../env";
import { apiError } from "../lib/errors";
import { parseManifest } from "../lib/manifest";
import * as github from "../hosts/github";
import * as gitlab from "../hosts/gitlab";
import { githubUserToken, gitlabToken, hostForSource } from "../hosts/repo";
import { audit, requireUser } from "./auth";
import { requireMember, sourceForPackage } from "./sources";
import {
  MAX_BULK, ImportProblem, draftProblems, editImport, finishImport, importById, installUrl, manifestYaml, missingFields, openChange,
  heldManifestProblems, parseRepoRef, requireOwnImport, startImports, suggestedFields, type Detection, type FinishMode, type ImportRow, type Provider,
} from "../imports";

/** Runs wizard code, turning its refusals into API errors (with the draft's problems when there are any). */
async function wizard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ImportProblem) {
      const problems = (e as ImportProblem & { problems?: unknown[] }).problems;
      if (problems) throw new HTTPException(e.status, { res: Response.json({ error: { code: e.code, message: e.message, problems } }, { status: e.status }) });
      apiError(e.status, e.code, e.message, e.hint);
    }
    throw e;
  }
}

/** What the wizard shows for an import: detection, the draft and what is still missing. */
async function view(env: Env, row: ImportRow) {
  const detection = row.detection_json ? (JSON.parse(row.detection_json) as Detection) : null;
  const draft = row.draft_manifest_json ? (JSON.parse(row.draft_manifest_json) as Record<string, unknown>) : null;
  const facts = detection?.facts;
  const published = row.url
    ? await env.DB.prepare(
      `SELECT n.name AS ns, t.name, t.latest_version_id IS NOT NULL AS live FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE lower(t.repo_url) = lower(?)`,
    ).bind(row.url).first<{ ns: string; name: string; live: number }>()
    : null;
  return {
    id: row.id,
    batch_id: row.batch_id ?? undefined,
    provider: row.provider,
    repo: row.path,
    url: row.url,
    status: row.status,
    error: row.error_code ? { code: row.error_code, message: row.error } : undefined,
    namespace: row.namespace,
    detected_kind: row.detected_kind,
    signals: facts?.signals ?? [],
    assumed: detection?.assumed ?? [],
    warnings: detection?.warnings ?? [],
    existing_manifest: facts?.existingManifest ?? false,
    app_installed: facts?.appInstalled ?? null,
    install_url: row.provider === "github" && facts && !facts.appInstalled ? installUrl(env) : undefined,
    can_hold_manifest: facts?.canHoldManifest ?? false,
    finish_modes: !facts ? [] : facts.existingManifest ? ["connect"] : facts.canHoldManifest ? ["pr", "registry"] : ["pr"],
    draft,
    draft_yaml: draft ? manifestYaml(draft) : null,
    problems: draft && row.status !== "finished" ? await draftProblems(env, row, draft) : [],
    missing: draft ? missingFields(draft) : [],
    suggested: draft ? suggestedFields(draft) : [],
    finish_mode: row.finish_mode ?? undefined,
    pr_url: row.pr_url ?? undefined,
    package: published ? { ref: `${published.ns}/${published.name}`, published: published.live === 1 } : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Registry-held manifests are the owners' to change: namespace owners (or registry admins). */
async function requireOwner(env: Env, namespaceId: string | null, user: { id: string; is_admin: number }) {
  const m = namespaceId
    ? await env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(namespaceId, user.id).first<{ role: string }>()
    : null;
  if (m?.role !== "owner" && !user.is_admin) apiError(403, "forbidden", "only the package's owners can change a registry-held manifest");
}

const providerParam = (v: string | undefined): Provider => {
  if (v !== undefined && v !== "github" && v !== "gitlab") apiError(400, "unknown_provider", "provider must be github or gitlab");
  return (v ?? "github") as Provider;
};

export function importRoutes(app: App) {
  // Repositories the signed-in user can import: GitHub admin, GitLab Maintainer or above, public only.
  app.get("/me/repos", async (c) => {
    const u = requireUser(c);
    const provider = providerParam(c.req.query("provider"));
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    type Item = { project_id: string; path: string; url: string; description: string | null; default_branch: string | null; archived: boolean; app_installed?: boolean };
    let items: Item[];
    if (provider === "github") {
      let token: string;
      try {
        token = await githubUserToken(c.env, u.id);
      } catch {
        apiError(400, "github_not_linked", "link your GitHub account first", "sign in with GitHub from Settings");
      }
      const repos = (await github.listUserRepos(deps.fetch, token)).filter((r) => r.permissions?.admin && !r.private && (!q || r.full_name.toLowerCase().includes(q)));
      const installs = (await c.env.DB.prepare(
        `SELECT lower(account_login) AS login, repo_ids, repository_selection FROM installations
         WHERE suspended_at IS NULL AND lower(account_login) IN (SELECT lower(value) FROM json_each(?))`,
      ).bind(JSON.stringify([...new Set(repos.map((r) => r.owner.login))])).all<{ login: string; repo_ids: string; repository_selection: string }>()).results;
      const installed = (owner: string, id: string) =>
        installs.some((i) => i.login === owner.toLowerCase() && (i.repository_selection === "all" || (JSON.parse(i.repo_ids) as string[]).includes(id)));
      items = repos.map((r) => ({
        project_id: String(r.id), path: r.full_name, url: r.html_url, description: r.description, default_branch: r.default_branch,
        archived: r.archived, app_installed: installed(r.owner.login, String(r.id)),
      }));
    } else {
      let token: string;
      try {
        token = await gitlabToken(c.env, u.id);
      } catch {
        apiError(400, "gitlab_not_linked", "link your GitLab account first", "sign in with GitLab from Settings");
      }
      items = (await gitlab.listProjects(deps.fetch, token, q)).map((p) => ({
        project_id: String(p.id), path: p.path_with_namespace, url: p.web_url, description: p.description ?? null, default_branch: p.default_branch, archived: p.archived,
      }));
    }
    const published = (await c.env.DB.prepare(
      `SELECT s.project_id, n.name AS ns, t.name FROM sources s JOIN tools t ON t.id = s.tool_id JOIN namespaces n ON n.id = t.namespace_id
       WHERE s.provider = ? AND s.project_id IN (SELECT value FROM json_each(?))`,
    ).bind(provider, JSON.stringify(items.map((i) => i.project_id))).all<{ project_id: string; ns: string; name: string }>()).results;
    const refs = new Map(published.map((p) => [p.project_id, `${p.ns}/${p.name}`]));
    return c.json({
      provider,
      install_url: provider === "github" ? installUrl(c.env) : undefined,
      repos: items.map((i) => ({ ...i, published_as: refs.get(i.project_id) ?? null })),
    });
  });

  // Start an import: {repo} or {repos: [...]}, as URLs or paths (with {provider} for bare paths).
  app.post("/imports", async (c) => {
    const u = requireUser(c);
    const body = await c.req.json<{ provider?: string; repo?: string; repos?: string[] }>().catch(() => ({}) as { provider?: string; repo?: string; repos?: string[] });
    const fallback = body.provider === undefined ? undefined : providerParam(body.provider);
    const inputs = body.repos ?? (body.repo ? [body.repo] : []);
    if (!Array.isArray(inputs) || inputs.length === 0) apiError(400, "invalid_body", "send {repo: 'https://github.com/owner/name'} or {repos: [...]}");
    if (inputs.length > MAX_BULK) apiError(400, "too_many_repos", `import at most ${MAX_BULK} repositories at once`);
    const refs: { provider: Provider; path: string }[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const ref = typeof input === "string" ? parseRepoRef(input, fallback) : null;
      if (!ref) apiError(400, "invalid_repo", `"${String(input)}" is not a GitHub or GitLab repository`, "use a URL such as https://github.com/owner/name");
      const key = `${ref.provider}:${ref.path.toLowerCase()}`;
      if (!seen.has(key)) refs.push(ref);
      seen.add(key);
    }
    const rows = await wizard(() => startImports(c.env, u, refs));
    const views = await Promise.all(rows.map((r) => view(c.env, r)));
    return c.json(refs.length === 1 ? views[0] : { batch_id: rows[0]?.batch_id, imports: views }, refs.length === 1 ? 201 : 202);
  });

  app.get("/imports", async (c) => {
    const u = requireUser(c);
    const batch = c.req.query("batch");
    const rows = (await c.env.DB.prepare(
      `SELECT * FROM imports WHERE user_id = ? ${batch ? "AND batch_id = ?" : ""} ORDER BY created_at DESC LIMIT 100`,
    ).bind(...(batch ? [u.id, batch] : [u.id])).all<ImportRow>()).results;
    return c.json({ imports: await Promise.all(rows.map((r) => view(c.env, r))) });
  });

  app.get("/imports/:id", async (c) => {
    const u = requireUser(c);
    const row = requireOwnImport(u, await importById(c.env, c.req.param("id")));
    return c.json(await view(c.env, row));
  });

  // Edit the draft: {manifest: {...partial}} merges top-level keys (null removes one), {yaml} replaces it,
  // {kind} rebuilds it for docker, pipx or guide.
  app.patch("/imports/:id", async (c) => {
    const u = requireUser(c);
    const row = requireOwnImport(u, await importById(c.env, c.req.param("id")));
    const body = await c.req.json<{ manifest?: Record<string, unknown>; yaml?: string; kind?: string }>().catch(() => null);
    if (!body || (body.manifest === undefined && body.yaml === undefined && body.kind === undefined)) {
      apiError(400, "invalid_body", "send {manifest: {...}}, {yaml: '...'} or {kind: 'docker' | 'pipx' | 'guide'}");
    }
    if (body.manifest !== undefined && (typeof body.manifest !== "object" || Array.isArray(body.manifest))) apiError(400, "invalid_body", "manifest must be an object");
    await wizard(() => editImport(c.env, row, body));
    return c.json(await view(c.env, (await importById(c.env, row.id))!));
  });

  // Finish: {mode: "pr"} opens a pull/merge request, "registry" keeps the manifest on the registry,
  // "connect" links a repository that already has otinstaller.yaml.
  app.post("/imports/:id/finish", async (c) => {
    const u = requireUser(c);
    const row = requireOwnImport(u, await importById(c.env, c.req.param("id")));
    const { mode = "pr" } = await c.req.json<{ mode?: string }>().catch(() => ({}) as { mode?: string });
    if (!["pr", "registry", "connect"].includes(mode)) apiError(400, "invalid_mode", "mode must be pr, registry or connect");
    const out = await wizard(() => finishImport(c.env, u, row, mode as FinishMode));
    return c.json({ ...(await view(c.env, (await importById(c.env, row.id))!)), queued_tag: out.queued ?? undefined });
  });

  // Edit a registry-held manifest. It takes effect on the next tag; published versions never change.
  app.put("/packages/:ns/:name/manifest", async (c) => {
    const { ns, name } = c.req.param();
    const s = await sourceForPackage(c.env, ns, name);
    const u = await requireMember(c, s.namespace_id);
    await requireOwner(c.env, s.namespace_id, u);
    const held = await c.env.DB.prepare(`SELECT manifest_mode FROM sources WHERE id = ?`).bind(s.id).first<{ manifest_mode: string }>();
    if (held?.manifest_mode !== "registry") apiError(409, "manifest_in_repo", `${ns}/${name} keeps its manifest in its repository; edit otinstaller.yaml there`);
    const body = await c.req.json<{ manifest?: Record<string, unknown>; yaml?: string }>().catch(() => ({}) as { manifest?: Record<string, unknown>; yaml?: string });
    let text: string;
    if (typeof body.yaml === "string") text = body.yaml;
    else if (body.manifest && typeof body.manifest === "object") text = JSON.stringify(body.manifest);
    else apiError(400, "invalid_body", "send {manifest: {...}} or {yaml: '...'}");
    const { manifest, problems } = parseManifest(text);
    if (manifest && (manifest.namespace !== ns || manifest.name !== name)) {
      problems.push({ code: "manifest_name_mismatch", path: "/name", message: `this manifest is for ${ns}/${name}; namespace and name cannot change` });
    }
    if (manifest) problems.push(...heldManifestProblems(manifest));
    if (!manifest || problems.length) return c.json({ error: { code: "manifest_invalid", message: `the manifest has ${problems.length} problem(s)`, problems } }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE sources SET registry_manifest_json = ? WHERE id = ?`).bind(JSON.stringify(manifest), s.id),
      audit(c.env.DB, u.id, "user", "manifest.edit", "source", s.id),
    ]);
    return c.json({ manifest, note: "Saved. The next vX.Y.Z tag publishes a version with this manifest." });
  });

  // One click to move a registry-held manifest into the repository with a pull or merge request.
  app.post("/packages/:ns/:name/manifest/pr", async (c) => {
    const { ns, name } = c.req.param();
    const s = await sourceForPackage(c.env, ns, name);
    const u = await requireMember(c, s.namespace_id);
    await requireOwner(c.env, s.namespace_id, u);
    const row = await c.env.DB.prepare(
      `SELECT s.manifest_mode, s.registry_manifest_json, s.default_branch, v.version FROM sources s
       LEFT JOIN tools t ON t.id = s.tool_id LEFT JOIN versions v ON v.id = t.latest_version_id WHERE s.id = ?`,
    ).bind(s.id).first<{ manifest_mode: string; registry_manifest_json: string | null; default_branch: string | null; version: string | null }>();
    if (row?.manifest_mode !== "registry" || !row.registry_manifest_json) apiError(409, "manifest_in_repo", `${ns}/${name} already keeps its manifest in its repository`);
    const draft = JSON.parse(row.registry_manifest_json) as Record<string, unknown>;
    if (row.version) draft.version = row.version;
    let branch = row.default_branch;
    let hasGitlabCi = false;
    const host = hostForSource(c.env, s);
    if (!branch) branch = (await host.metadata())?.defaultBranch ?? "main";
    if (s.provider === "gitlab") hasGitlabCi = (await host.fileAt(".gitlab-ci.yml", branch)) !== null;
    const pr = await wizard(() =>
      openChange(c.env, u, { provider: s.provider, projectId: s.project_id, path: s.path ?? "", defaultBranch: branch!, installationId: s.installation_id, hasGitlabCi }, draft),
    );
    await audit(c.env.DB, u.id, "user", "manifest.move_pr", "source", s.id, { pr: pr.url }).run();
    return c.json({ pr_url: pr.url, note: "Once this is merged, the next tag publishes from otinstaller.yaml in the repository and the registry-held label goes away." }, 201);
  });
}
