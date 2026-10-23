// Direct publishing: namespaces a signed-in user creates on the registry, and releases uploaded as a bundle by
// `ot publish` instead of read from a tagged commit. An upload becomes an ordinary publish job (publish.ts) whose
// files come from R2 CONTENT under uploads/<jobId>/ rather than from GitHub or GitLab; scans, review, publishing
// and backups are the same as for a tag. A CI run uploads the same way with a token from trusted publishing
// (trusted.ts), and its job names the repository the run's ID token proved instead of "direct".
import type { Context } from "hono";
import { deps, type AppEnv, type Env, type User } from "./env";
import { apiError, rateLimited, windowRetry } from "./lib/errors";
import { ulid } from "./lib/crypto";
import { parseManifest } from "./lib/manifest";
import { REGISTRY_RESERVED, RESERVED_NAMESPACES } from "./lib/reserved";
import { overLimit } from "./trust";
import { ownerEmails, sendEmail, templates } from "./notify";
import { audit, requireUser } from "./routes/auth";
import * as github from "./hosts/github";
import { GITLAB } from "./hosts/gitlab";
import { githubUserToken, repoUrl, type RepoHost } from "./hosts/repo";
import type { Restriction } from "./lib/tokens";

export const BUNDLE_FILE = "otinstaller.yaml";
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 300;
const MAX_NAMESPACES_PER_USER = 3;
const PUBLISHES_PER_HOUR = 20;
// Registry namespaces nobody publishes into are removed after this long, so names aren't held idle.
export const IDLE_NAMESPACE_MS = 30 * 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// The site's own sections (refused for every new namespace) and names that pass for the registry's own.
const RESERVED = new Set([...RESERVED_NAMESPACES, ...REGISTRY_RESERVED]);

// ---------- namespaces ----------

type HostAccount = { provider: "github" | "gitlab"; kind: "user" | "org"; id: string };

/** A GitHub token for looking names up: the user's own sign-in, else the App's ops installation, else none. */
async function lookupToken(env: Env, user: User): Promise<string | null> {
  try {
    return await githubUserToken(env, user.id);
  } catch {
    // Not signed in with GitHub.
  }
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.OPS_INSTALLATION_ID) {
    try {
      return await github.installationToken(deps.fetch, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Number(env.OPS_INSTALLATION_ID));
    } catch {
      // Anonymous lookups work too, at a lower rate limit.
    }
  }
  return null;
}

const lookupFailed = (host: string): never =>
  apiError(503, "account_check_failed", `could not check ${host} for this name`, "try again in a minute");

/** The GitHub and GitLab accounts (people, organisations, groups) whose name is `name`. */
async function hostAccounts(env: Env, user: User, name: string): Promise<HostAccount[]> {
  const found: HostAccount[] = [];
  const token = await lookupToken(env, user);
  const gh = await deps.fetch(`${github.GITHUB_API}/users/${encodeURIComponent(name)}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "otinstaller-registry", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (gh.ok) {
    const u = (await gh.json()) as { id: number; type?: string };
    found.push({ provider: "github", kind: u.type === "Organization" ? "org" : "user", id: String(u.id) });
  } else if (gh.status !== 404) {
    lookupFailed("GitHub");
  }
  const users = await deps.fetch(`${GITLAB}/api/v4/users?username=${encodeURIComponent(name)}`, { headers: { Accept: "application/json" } });
  if (!users.ok) lookupFailed("GitLab");
  const person = ((await users.json()) as { id: number; username: string }[]).find((u) => u.username.toLowerCase() === name);
  if (person) {
    found.push({ provider: "gitlab", kind: "user", id: String(person.id) });
  } else {
    const group = await deps.fetch(`${GITLAB}/api/v4/groups/${encodeURIComponent(name)}?with_projects=false`, { headers: { Accept: "application/json" } });
    if (group.ok) found.push({ provider: "gitlab", kind: "org", id: String(((await group.json()) as { id: number }).id) });
    else if (group.status !== 404) lookupFailed("GitLab");
  }
  return found;
}

/**
 * Someone's GitHub or GitLab name is theirs: a person's name needs that account linked to the user, and an
 * organisation's or group's comes from the GitHub App or a connected GitLab project, never from a registry namespace.
 */
async function requireNameOwner(env: Env, user: User, name: string) {
  for (const a of await hostAccounts(env, user, name)) {
    const host = a.provider === "github" ? "GitHub" : "GitLab";
    if (a.kind === "org") {
      apiError(403, "namespace_account_required", `${name} is a ${a.provider === "github" ? "GitHub organisation" : "GitLab group"}`,
        a.provider === "github" ? `install the OTInstaller GitHub App on ${name} to get this namespace` : `connect one of ${name}'s projects from the import wizard to get this namespace`);
    }
    const linked = await env.DB.prepare(`SELECT 1 FROM accounts WHERE user_id = ? AND provider = ? AND provider_user_id = ?`).bind(user.id, a.provider, a.id).first();
    if (!linked) apiError(403, "namespace_account_required", `${name} is a ${host} user's name`, `sign in with that ${host} account (Settings → Accounts) to claim it, or pick another name`);
  }
}

/**
 * Creates a registry namespace owned by the signed-in user. Like every new publisher it waits for a reviewer, who
 * sees its first release before anything goes public.
 */
export async function createNamespace(env: Env, user: User, body: { name?: unknown; kind?: unknown }) {
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!SLUG.test(name)) apiError(400, "invalid_body", "send {name}: 3-40 lowercase letters, digits and hyphens, not starting or ending with a hyphen");
  const kind = body.kind ?? "user";
  if (kind !== "user" && kind !== "org") apiError(400, "invalid_body", "kind must be user or org");
  if (RESERVED.has(name)) apiError(400, "namespace_reserved", `${name} is reserved for the registry's own pages`, "pick another name");
  const taken = () => apiError(409, "namespace_taken", `${name} is already a namespace`, "pick another name, or ask its owners to add you");
  if (await env.DB.prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(name).first()) taken();
  const made = await env.DB.prepare(`SELECT COUNT(*) AS n FROM namespaces WHERE provider = 'registry' AND created_by = ?`).bind(user.id).first<{ n: number }>();
  if ((made?.n ?? 0) >= MAX_NAMESPACES_PER_USER) {
    apiError(403, "namespace_limit", `you have created ${MAX_NAMESPACES_PER_USER} namespaces, the most one account can`, "publish into one of them, or write to support@otinstaller.com");
  }
  if (await overLimit(env, "namespace_create", user.id, 5, 86_400_000)) {
    rateLimited("too_many_requests", "at most 5 namespace attempts a day", "try again tomorrow", windowRetry(86_400_000), 5, 86_400);
  }
  await requireNameOwner(env, user, name);
  const id = ulid();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO namespaces (id, provider, provider_owner_id, name, kind, display_name, status, created_by, created_at)
         VALUES (?, 'registry', ?, ?, ?, ?, 'pending_review', ?, ?)`,
      ).bind(id, id, name, kind, name, user.id, now),
      env.DB.prepare(`INSERT INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(id, user.id),
      audit(env.DB, user.id, "user", "namespace.create", "namespace", id, { name, provider: "registry" }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) taken();
    throw e;
  }
  return { name, kind, status: "pending_review" };
}

/** Removes registry namespaces that got no package within 30 days of being created. */
export async function purgeIdleNamespaces(env: Env, now = Date.now()) {
  const idle = await env.DB.prepare(
    `SELECT id, name FROM namespaces n WHERE provider = 'registry' AND created_by IS NOT NULL AND status = 'pending_review' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM tools WHERE namespace_id = n.id)
       AND NOT EXISTS (SELECT 1 FROM transfers WHERE from_namespace_id = n.id OR to_namespace_id = n.id)
       AND NOT EXISTS (SELECT 1 FROM publish_jobs WHERE namespace_id = n.id AND status IN ('queued', 'validating', 'scanning'))
     LIMIT 50`,
  ).bind(now - IDLE_NAMESPACE_MS).all<{ id: string; name: string }>();
  for (const ns of idle.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE publish_jobs SET namespace_id = NULL WHERE namespace_id = ?`).bind(ns.id),
      env.DB.prepare(`DELETE FROM namespace_members WHERE namespace_id = ?`).bind(ns.id),
      env.DB.prepare(`DELETE FROM namespaces WHERE id = ?`).bind(ns.id),
      audit(env.DB, null, "system", "namespace.expire", "namespace", ns.id, { name: ns.name }),
    ]);
  }
  return idle.results.length;
}

// ---------- uploads ----------

/** A path as a manifest names files: relative, forward slashes, no "." or ".." parts. Null when it isn't one. */
export function bundlePath(name: string): string | null {
  if (!name || name.length > 300 || name.includes("\\") || name.startsWith("/") || /[\u0000-\u001f:]/.test(name)) return null;
  return name.split("/").some((p) => p === "" || p === "." || p === "..") ? null : name;
}

// `ci` is set for an upload from a CI run (trusted publishing, trusted.ts): the repository its ID token proved.
type Target = { nsId: string; ns: string; provider: string; name: string; version: string; user: User; ci: Ci | null; publisherId: string | null };
type Ci = NonNullable<Restriction["ci"]>;

/** The upload's namespace, name and version, from the query so nothing is read before the caller may publish there. */
async function uploadTarget(c: Context<AppEnv>): Promise<Target> {
  const user = requireUser(c);
  const ns = c.req.query("namespace") ?? "", name = c.req.query("name") ?? "", version = c.req.query("version") ?? "";
  if (!SLUG.test(ns) || !SLUG.test(name) || !SEMVER.test(version)) {
    apiError(400, "invalid_parameter", "send ?namespace=&name=&version= as the manifest gives them", "`ot publish` does this for you");
  }
  const row = await c.env.DB.prepare(`SELECT id, provider, status FROM namespaces WHERE name = ?`).bind(ns).first<{ id: string; provider: string; status: string }>();
  if (!row) apiError(404, "namespace_unknown", `${ns} is not a namespace on the registry`, `create it with \`ot namespace create ${ns}\``);
  const r = c.get("token")?.restriction ?? null;
  if (r && r.namespaceId !== row.id) apiError(403, "forbidden", `this CI token publishes only into the namespace it was issued for, not ${ns}`);
  if (r?.pkg && r.pkg !== name) apiError(403, "forbidden", `this CI token publishes only ${r.pkg}, not ${name}`);
  const member = await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(row.id, user.id).first();
  if (!member) apiError(403, "forbidden", `you are not an owner or publisher of ${ns}`, "publish into your own namespace, or ask one of its owners to add you");
  if (row.status === "rejected" || row.status === "suspended") {
    apiError(403, "namespace_not_allowed", `namespace ${ns} is ${row.status} and cannot publish`, "contact abuse@otinstaller.com");
  }
  return { nsId: row.id, ns, provider: row.provider, name, version, user, ci: r?.ci ?? null, publisherId: r?.publisherId ?? null };
}

/**
 * A CI upload of a release the registry already has from the same repository: the App's webhook got the tag first,
 * or this is a retry. The CLI follows that job instead.
 */
async function sameRelease(env: Env, t: Target): Promise<{ id: string; status: string } | null> {
  if (!t.ci) return null;
  return env.DB.prepare(
    `SELECT j.id, j.status FROM publish_jobs j
     LEFT JOIN installations i ON i.github_installation_id = j.installation_id LEFT JOIN sources s ON s.id = j.source_id
     WHERE j.provider = ? AND j.repo_id = ? AND j.tag = ? AND COALESCE(j.namespace_id, i.namespace_id, s.namespace_id) = ?
       AND j.status IN ('queued', 'validating', 'scanning', 'awaiting_review', 'published')
     ORDER BY j.created_at DESC LIMIT 1`,
  ).bind(t.ci.provider, t.ci.repository_id, `v${t.version}`, t.nsId).first<{ id: string; status: string }>();
}

/** What would stop the release anyway, answered before the upload is read. */
async function uploadConflicts(env: Env, t: Target) {
  const tool = await env.DB.prepare(`SELECT id, repo_url FROM tools WHERE namespace_id = ? AND name = ?`).bind(t.nsId, t.name).first<{ id: string; repo_url: string | null }>();
  // A package's name belongs to the repository that first published it; a CI run proves which repository it is.
  if (tool?.repo_url && tool.repo_url !== (t.ci ? repoUrl(t.ci.provider, t.ci.repository) : null)) {
    apiError(409, "manifest_name_taken", `${t.ns}/${t.name} is published from ${tool.repo_url}`,
      t.ci ? "release it from that repository's CI" : "release it from that repository; uploads are for packages without one");
  }
  if (tool && (await env.DB.prepare(`SELECT 1 FROM versions WHERE tool_id = ? AND version = ? AND status != 'rejected'`).bind(tool.id, t.version).first())) {
    apiError(409, "manifest_version_exists", `${t.name} ${t.version} is already published; versions are immutable`, "bump the version");
  }
  const busy = await env.DB.prepare(`SELECT id FROM publish_jobs WHERE namespace_id = ? AND repo = ? AND tag = ? AND status IN ('queued', 'validating') LIMIT 1`)
    .bind(t.nsId, `${t.ns}/${t.name}`, `v${t.version}`).first<{ id: string }>();
  if (busy) apiError(409, "publish_in_progress", `${t.ns}/${t.name} ${t.version} is already being published (job ${busy.id})`, "wait for it with `ot publish --wait`, or see the dashboard");
}

/** The upload's files by path. The body is read once, after the caller and the release were checked. */
async function readBundle(c: Context<AppEnv>): Promise<Map<string, File>> {
  const length = Number(c.req.header("content-length"));
  if (!Number.isFinite(length)) apiError(400, "bundle_invalid", "send the upload with a Content-Length header");
  const tooLarge = () => apiError(413, "bundle_too_large", `the upload is over ${MAX_BUNDLE_BYTES / 1048576} MB`, "leave large files out: only the manifest, its README and pages, and their images are needed");
  if (length > MAX_BUNDLE_BYTES) tooLarge();
  const type = c.req.header("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) apiError(400, "bundle_invalid", "send the files as multipart/form-data, one part each, named by its path");
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_BUNDLE_BYTES) tooLarge();
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": type } }).formData();
  } catch {
    apiError(400, "bundle_invalid", "the upload is not valid multipart/form-data");
  }
  // Each part is named by its file's path. The name, unlike a part's filename, is never cut down to its last segment.
  const files = new Map<string, File>();
  for (const [name, part] of form.entries()) {
    if (typeof part === "string") apiError(400, "bundle_invalid", `part "${name}" is not a file`);
    const path = bundlePath(name);
    if (!path) apiError(400, "bundle_invalid", `"${name}" is not a relative path inside the package`);
    if (files.has(path)) apiError(400, "bundle_invalid", `${path} is in the upload twice`);
    files.set(path, part);
  }
  if (files.size > MAX_BUNDLE_FILES) apiError(400, "bundle_invalid", `the upload has ${files.size} files; at most ${MAX_BUNDLE_FILES}`);
  return files;
}

/**
 * Accepts a release uploaded with `ot publish`: checks who is publishing and what, stores the files under
 * uploads/<jobId>/ and queues the job. Validation, checks and publishing then run as they do for a tag.
 */
export async function acceptUpload(c: Context<AppEnv>): Promise<{ status: 200 | 202; body: Record<string, unknown> }> {
  const env = c.env;
  const t = await uploadTarget(c);
  const ref = `${t.ns}/${t.name}`;
  const prior = await sameRelease(env, t);
  if (prior) {
    return { status: 200, body: { job_id: prior.id, status: prior.status, ref, version: t.version, url: `${env.SITE_URL}/dashboard/publish/${prior.id}`, already_received: true } };
  }
  await uploadConflicts(env, t);
  if (await overLimit(env, "publish", t.nsId, PUBLISHES_PER_HOUR, 3_600_000)) {
    rateLimited("publish_rate_limited", `at most ${PUBLISHES_PER_HOUR} uploads an hour per namespace`, "wait and try again", windowRetry(3_600_000), PUBLISHES_PER_HOUR, 3600);
  }
  const files = await readBundle(c);
  const yaml = files.get(BUNDLE_FILE);
  if (!yaml) apiError(400, "bundle_invalid", `the upload has no ${BUNDLE_FILE}`);
  const { manifest, problems } = parseManifest(await yaml.text());
  if (!manifest || problems.length) apiError(400, "manifest_invalid", `the manifest has ${problems.length} problem(s)`, "run `ot validate` to see them", { problems });
  if (manifest.namespace !== t.ns || manifest.name !== t.name || manifest.version !== t.version) {
    apiError(400, "bundle_invalid", `the query names ${t.ns}/${t.name} ${t.version} but the manifest is ${manifest.namespace}/${manifest.name} ${manifest.version}`);
  }

  const jobId = ulid();
  const key = `uploads/${jobId}`;
  for (const [path, file] of files) await env.CONTENT.put(`${key}/${path}`, await file.arrayBuffer());
  const now = Date.now();
  // An upload from CI is the repository's release: its tag and commit when the run was for a tag. On a branch (the
  // release templates tag at the end of the run) the claim's commit is from before the release commit, so none is kept.
  const ci = t.ci;
  const tagged = ci?.ref_type === "tag" && ci.ref.startsWith("refs/tags/");
  const tag = tagged ? ci!.ref.slice("refs/tags/".length) : `v${t.version}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO publish_jobs (id, delivery_id, provider, repo, repo_id, tag, commit_sha, namespace_id, bundle_key, submitted_by, trusted_publisher_id, ci_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(
      jobId, `${ci ? "ci" : "direct"}:${jobId}`, ci?.provider ?? "direct", ci?.repository ?? ref, ci?.repository_id ?? "", tag, tagged ? ci!.sha : null,
      t.nsId, key, t.user.id, t.publisherId, ci ? JSON.stringify({ workflow: ci.workflow, ref: ci.ref, sha: ci.sha, run: ci.run }) : null, now, now,
    ),
    audit(env.DB, t.user.id, ci?.provider ?? "user", "publish.upload", "publish_job", jobId, { ref, version: t.version, files: files.size, ...(ci ? { repository: ci.repository, workflow: ci.workflow, run: ci.run } : {}) }),
  ]);
  await env.PUBLISH_QUEUE.send({ jobId });
  // A member who has left the GitHub organisation or GitLab group can still upload, so its owners hear of every upload.
  // A CI run publishes only through a publisher an owner added.
  if (t.provider !== "registry" && !ci) {
    await sendEmail(env, { to: await ownerEmails(env, t.nsId), kind: "direct_publish", key: `direct_publish:${jobId}`, ...templates.directPublish(env, ref, t.version, t.user.login) });
  }
  return { status: 202, body: { job_id: jobId, status: "queued", ref, version: t.version, url: `${env.SITE_URL}/dashboard/publish/${jobId}` } };
}

/** A release's files from its upload, behind the same interface as a repository at a commit (publish.ts reads both). */
export function bundleHost(env: Env, key: string, provider: RepoHost["provider"]): RepoHost {
  const get = (path: string) => env.CONTENT.get(`${key}/${path}`);
  return {
    provider,
    tagCommit: async () => "",
    fileAt: async (path) => (await get(path))?.text() ?? null,
    fileBytes: async (path) => {
      const obj = await get(path);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    // Nothing to mark: there is no commit. The CLI and the dashboard show the job instead.
    setStatus: async () => {},
    listTags: async () => ({ notModified: true, tags: [], etag: null }),
    metadata: async () => null,
    // An upload has no release on a host; its notes come from a CHANGELOG.md in the upload instead (changelog.ts).
    releaseNotes: async () => null,
  };
}

/** Deletes an upload once its release is recorded; an R2 lifecycle rule on uploads/ catches any left behind. */
export async function deleteBundle(env: Env, key: string | null) {
  if (!key) return;
  let cursor: string | undefined;
  do {
    const page = await env.CONTENT.list({ prefix: `${key}/`, cursor });
    if (page.objects.length) await env.CONTENT.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
