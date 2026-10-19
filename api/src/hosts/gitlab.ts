// GitLab.com: OAuth sign-in and device flow, project webhooks, and the calls the import wizard needs.
import { HostError, deviceStatus, type DirEntry, type Fetch, type FileChange, type OAuthUser } from "./github";

export const GITLAB = "https://gitlab.com";
const SCOPES = "read_user read_api";

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
}

/** `withApi` asks for the `api` scope too, which connecting a project (creating its webhook) needs. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string, withApi = false): string {
  const u = new URL(`${GITLAB}/oauth/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("scope", withApi ? `${SCOPES} api` : SCOPES);
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

function tokens(t: TokenResponse) {
  return {
    accessToken: t.access_token!,
    refreshToken: t.refresh_token ?? null,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    scopes: t.scope ?? SCOPES,
  };
}

export async function exchangeCode(f: Fetch, clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const res = await check(
    await f(`${GITLAB}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }),
    }),
    "GitLab token exchange",
  );
  const t = (await res.json()) as TokenResponse;
  if (!t.access_token) throw new HostError(`GitLab sign-in failed: ${t.error_description ?? t.error ?? "no token"}`, 400, false);
  return tokens(t);
}

export async function fetchUser(f: Fetch, token: string): Promise<OAuthUser> {
  const res = await check(await f(`${GITLAB}/api/v4/user`, { headers: { Authorization: `Bearer ${token}` } }), "GitLab /user");
  const u = (await res.json()) as any;
  return { id: String(u.id), login: u.username, name: u.name ?? null, email: u.email ?? u.public_email ?? null, avatarUrl: u.avatar_url ?? null };
}

// Confidential applications (ours) must authenticate with the client secret on both device-flow calls;
// without it GitLab answers 401 invalid_client.
export async function startDeviceFlow(f: Fetch, clientId: string, clientSecret: string) {
  const res = await check(
    await f(`${GITLAB}/oauth/authorize_device`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES }),
    }),
    "GitLab device code",
  );
  const d = (await res.json()) as any;
  return { deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri_complete ?? d.verification_uri, interval: d.interval ?? 5, expiresIn: d.expires_in };
}

export async function pollDeviceFlow(f: Fetch, clientId: string, clientSecret: string, deviceCode: string) {
  const res = await f(`${GITLAB}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  // GitLab answers "authorization_pending" with HTTP 400, so read the body before judging the status.
  const t = (await res.json().catch(() => ({}))) as TokenResponse;
  if (t.access_token) return { status: "ok" as const, ...tokens(t) };
  if (res.status >= 500) throw new HostError(`GitLab device token failed: ${res.status}`, res.status, true);
  return { status: deviceStatus(t.error) };
}

// ---------- projects and webhooks (connect flow) ----------

export interface GitlabProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  visibility: string;
  default_branch: string | null;
  archived: boolean;
  namespace: { id: number; path: string; kind: "user" | "group"; full_path: string };
  description?: string | null;
  topics?: string[];
  tag_list?: string[];
  star_count?: number;
  license?: { key: string } | null;
  owner?: { id: number; username: string } | null;
  permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null };
}

export const MAINTAINER = 40;
export const OWNER = 50;

export async function getProject(f: Fetch, token: string, project: string, withLicense = false): Promise<GitlabProject | null> {
  const res = await f(`${GITLAB}/api/v4/projects/${encodeURIComponent(project)}${withLicense ? "?license=true" : ""}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 403) return null;
  await check(res, "reading GitLab project");
  return (await res.json()) as GitlabProject;
}

export function accessLevel(p: GitlabProject): number {
  return Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
}

/** Creates the project webhook. Needs the `api` scope; a 403 means the user has to re-authorize. */
export async function createHook(f: Fetch, token: string, projectId: number, url: string, secret: string, branch: string | null) {
  const res = await f(`${GITLAB}/api/v4/projects/${projectId}/hooks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      token: secret,
      push_events: true,
      push_events_branch_filter: branch ?? undefined,
      tag_push_events: true,
      releases_events: true,
      enable_ssl_verification: true,
    }),
  });
  if (res.status === 403) throw new HostError("creating the webhook needs GitLab's api scope", 403, false);
  await check(res, "creating the GitLab webhook");
  return String(((await res.json()) as { id: number }).id);
}

export async function deleteHook(f: Fetch, token: string, projectId: string, hookId: string) {
  const res = await f(`${GITLAB}/api/v4/projects/${encodeURIComponent(projectId)}/hooks/${hookId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 404) await check(res, "deleting the GitLab webhook");
}

// ---------- import wizard ----------

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const projectApi = (id: string) => `${GITLAB}/api/v4/projects/${encodeURIComponent(id)}`;

/** Public projects where the user is Maintainer or above (first 300). */
export async function listProjects(f: Fetch, token: string, search = ""): Promise<GitlabProject[]> {
  const out: GitlabProject[] = [];
  for (let page = 1; page <= 3; page++) {
    const u = new URL(`${GITLAB}/api/v4/projects`);
    for (const [k, v] of Object.entries({ membership: "true", min_access_level: String(MAINTAINER), visibility: "public", order_by: "last_activity_at", per_page: "100", page: String(page) })) {
      u.searchParams.set(k, v);
    }
    if (search) u.searchParams.set("search", search);
    const res = await check(await f(u, { headers: auth(token) }), "listing GitLab projects");
    const batch = (await res.json()) as GitlabProject[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Files and folders directly inside `dir` ("" for the root), or null when it does not exist. */
export async function listTree(f: Fetch, token: string, projectId: string, dir: string, ref: string): Promise<DirEntry[] | null> {
  const u = new URL(`${projectApi(projectId)}/repository/tree`);
  u.searchParams.set("ref", ref);
  u.searchParams.set("per_page", "100");
  if (dir) u.searchParams.set("path", dir);
  const res = await f(u, { headers: auth(token) });
  if (res.status === 404) return null;
  await check(res, `listing ${dir || "the repository root"}`);
  return ((await res.json()) as { name: string; type: string }[]).map((e) => ({ name: e.name, type: e.type === "tree" ? "dir" : "file" }));
}

export async function rawFile(f: Fetch, token: string, projectId: string, path: string, ref: string): Promise<string | null> {
  const res = await f(`${projectApi(projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`, { headers: auth(token) });
  if (res.status === 404) return null;
  await check(res, `reading ${path}`);
  return res.text();
}

export async function listTags(f: Fetch, token: string, projectId: string): Promise<string[]> {
  const res = await check(await f(`${projectApi(projectId)}/repository/tags?per_page=100&order_by=updated`, { headers: auth(token) }), "listing tags");
  return ((await res.json()) as { name: string }[]).map((t) => t.name);
}

/**
 * Commits files to `branch` (started from, or reset to, the default branch) and opens a merge request,
 * or returns the one already open from that branch. Needs the `api` scope; a 403 means re-authorize.
 */
export async function openMergeRequest(
  f: Fetch, token: string, projectId: string, base: string, branch: string, files: (FileChange & { exists?: boolean })[], title: string, description: string,
): Promise<{ url: string; number: number }> {
  const json = { ...auth(token), "Content-Type": "application/json" };
  const commit = await f(`${projectApi(projectId)}/repository/commits`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      branch, start_branch: base, force: true, commit_message: "Add otinstaller.yaml for the OTInstaller Registry",
      actions: files.map((file) => ({ action: file.exists ? "update" : "create", file_path: file.path, content: file.content })),
    }),
  });
  if (commit.status === 403) throw new HostError("opening a merge request needs GitLab's api scope", 403, false);
  await check(commit, "committing to the import branch");
  const mr = await f(`${projectApi(projectId)}/merge_requests`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ source_branch: branch, target_branch: base, title, description, remove_source_branch: true }),
  });
  if (mr.status === 409) {
    const open = await check(
      await f(`${projectApi(projectId)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`, { headers: auth(token) }),
      "finding the open merge request",
    );
    const first = ((await open.json()) as { web_url: string; iid: number }[])[0];
    if (first) return { url: first.web_url, number: first.iid };
  }
  const m = (await (await check(mr, "opening the merge request")).json()) as { web_url: string; iid: number };
  return { url: m.web_url, number: m.iid };
}
