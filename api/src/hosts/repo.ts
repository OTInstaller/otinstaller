// One interface over GitHub and GitLab repositories, so publishing, scans and sync do not care
// where a package's source lives.
import { deps, requireSecret, type Env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import * as github from "./github";
import { GITLAB } from "./gitlab";
import { HostError } from "./github";

export type CommitState = "pending" | "success" | "failure" | "error";

export interface RepoMeta {
  path: string;
  url: string;
  defaultBranch: string | null;
  description: string | null;
  topics: string[];
  stars: number;
  archived: boolean;
  visibility: "public" | "private" | "internal";
}

export interface RepoHost {
  provider: "github" | "gitlab";
  tagCommit(tag: string): Promise<string>;
  fileAt(path: string, sha: string): Promise<string | null>;
  setStatus(sha: string, state: CommitState, description: string, targetUrl: string): Promise<void>;
  /** Tags, newest first as the host returns them; notModified when the ETag still matches. */
  listTags(etag?: string | null): Promise<{ notModified: boolean; tags: string[]; etag: string | null }>;
  /** Current metadata, or null when the repository is gone or no longer accessible. */
  metadata(): Promise<RepoMeta | null>;
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
}

// ---------- GitHub (through the GitHub App installation) ----------

export function githubRepo(env: Env, installationId: number, repo: string, repoId: string): RepoHost {
  let token: Promise<string> | null = null;
  const auth = () =>
    (token ??= github.installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), installationId));
  const headers = async (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${await auth()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "otinstaller-registry",
    ...extra,
  });
  return {
    provider: "github",
    tagCommit: async (tag) => github.tagCommit(deps.fetch, await auth(), repo, tag),
    fileAt: async (path, sha) => github.fileAt(deps.fetch, await auth(), repo, path, sha),
    setStatus: async (sha, state, description, targetUrl) => github.setCommitStatus(deps.fetch, await auth(), repo, sha, state, description, targetUrl),
    async listTags(etag) {
      // Repository IDs survive renames and transfers; names do not.
      const res = await deps.fetch(`${github.GITHUB_API}/repositories/${repoId}/tags?per_page=100`, { headers: await headers(etag ? { "If-None-Match": etag } : {}) });
      if (res.status === 304) return { notModified: true, tags: [], etag: etag ?? null };
      await check(res, "listing tags");
      return { notModified: false, tags: ((await res.json()) as { name: string }[]).map((t) => t.name), etag: res.headers.get("etag") };
    },
    async metadata() {
      const res = await deps.fetch(`${github.GITHUB_API}/repositories/${repoId}`, { headers: await headers() });
      if (res.status === 404 || res.status === 403) return null;
      await check(res, "reading repository");
      const r = (await res.json()) as any;
      return {
        path: r.full_name, url: r.html_url, defaultBranch: r.default_branch ?? null, description: r.description ?? null,
        topics: r.topics ?? [], stars: r.stargazers_count ?? 0, archived: !!r.archived, visibility: r.private ? "private" : "public",
      };
    },
  };
}

// ---------- GitLab (with the connecting user's OAuth token) ----------

type GitlabAccount = { id: string; access_token_enc: string; refresh_token_enc: string | null; expires_at: number | null };

/** The connecting user's GitLab token, refreshed when it is about to expire. */
export async function gitlabToken(env: Env, userId: string): Promise<string> {
  const acct = await env.DB.prepare(
    `SELECT id, access_token_enc, refresh_token_enc, expires_at FROM accounts WHERE user_id = ? AND provider = 'gitlab'`,
  ).bind(userId).first<GitlabAccount>();
  if (!acct) throw new HostError("the user who connected this project no longer has a GitLab account linked", 401, false);
  const key = requireSecret(env, "TOKEN_ENC_KEY");
  if (!acct.expires_at || acct.expires_at > Date.now() + 60_000 || !acct.refresh_token_enc) return decrypt(key, acct.access_token_enc);
  const res = await deps.fetch(`${GITLAB}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: await decrypt(key, acct.refresh_token_enc),
      client_id: requireSecret(env, "GITLAB_CLIENT_ID"),
      client_secret: requireSecret(env, "GITLAB_CLIENT_SECRET"),
    }),
  });
  if (res.status === 400 || res.status === 401) throw new HostError("GitLab access was revoked; reconnect GitLab", 401, false);
  await check(res, "refreshing the GitLab token");
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  await env.DB.prepare(`UPDATE accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ? WHERE id = ?`)
    .bind(await encrypt(key, t.access_token), t.refresh_token ? await encrypt(key, t.refresh_token) : null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, acct.id)
    .run();
  return t.access_token;
}

/** The user's GitHub sign-in token, which the import wizard uses to see repositories as they do. */
export async function githubUserToken(env: Env, userId: string): Promise<string> {
  const acct = await env.DB.prepare(`SELECT access_token_enc FROM accounts WHERE user_id = ? AND provider = 'github'`)
    .bind(userId).first<{ access_token_enc: string | null }>();
  if (!acct?.access_token_enc) throw new HostError("link your GitHub account first", 401, false);
  return decrypt(requireSecret(env, "TOKEN_ENC_KEY"), acct.access_token_enc);
}

const GL_STATE: Record<CommitState, string> = { pending: "running", success: "success", failure: "failed", error: "failed" };

export function gitlabRepo(env: Env, projectId: string, userId: string): RepoHost {
  let token: Promise<string> | null = null;
  const auth = async () => ({ Authorization: `Bearer ${await (token ??= gitlabToken(env, userId))}` });
  const api = `${GITLAB}/api/v4/projects/${encodeURIComponent(projectId)}`;
  return {
    provider: "gitlab",
    async tagCommit(tag) {
      const res = await check(await deps.fetch(`${api}/repository/tags/${encodeURIComponent(tag)}`, { headers: await auth() }), `resolving tag ${tag}`);
      return ((await res.json()) as { commit: { id: string } }).commit.id;
    },
    async fileAt(path, sha) {
      const res = await deps.fetch(`${api}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(sha)}`, { headers: await auth() });
      if (res.status === 404) return null;
      await check(res, `reading ${path}`);
      return res.text();
    },
    async setStatus(sha, state, description, targetUrl) {
      await check(
        await deps.fetch(`${api}/statuses/${sha}`, {
          method: "POST",
          headers: { ...(await auth()), "Content-Type": "application/json" },
          body: JSON.stringify({ state: GL_STATE[state], name: "otinstaller/publish", description: description.slice(0, 255), target_url: targetUrl }),
        }),
        "setting commit status",
      );
    },
    async listTags(etag) {
      const res = await deps.fetch(`${api}/repository/tags?per_page=100&order_by=updated`, { headers: { ...(await auth()), ...(etag ? { "If-None-Match": etag } : {}) } });
      if (res.status === 304) return { notModified: true, tags: [], etag: etag ?? null };
      await check(res, "listing tags");
      return { notModified: false, tags: ((await res.json()) as { name: string }[]).map((t) => t.name), etag: res.headers.get("etag") };
    },
    async metadata() {
      const res = await deps.fetch(api, { headers: await auth() });
      if (res.status === 404 || res.status === 403) return null;
      await check(res, "reading project");
      const p = (await res.json()) as any;
      return {
        path: p.path_with_namespace, url: p.web_url, defaultBranch: p.default_branch ?? null, description: p.description ?? null,
        topics: p.topics ?? p.tag_list ?? [], stars: p.star_count ?? 0, archived: !!p.archived, visibility: p.visibility ?? "private",
      };
    },
  };
}

// ---------- by source row ----------

export type SourceRow = {
  id: string;
  tool_id: string | null;
  namespace_id: string | null;
  provider: "github" | "gitlab";
  project_id: string;
  path: string | null;
  url: string;
  installation_id: number | null;
  connected_by: string | null;
  etag: string | null;
  manifest_mode: "repo" | "registry";
  /** JSON array of the release tags the repository had when it was connected without a package. */
  baseline_tags: string | null;
  sync_status: string;
  archived: number;
  unavailable_since: number | null;
};

export function hostForSource(env: Env, s: SourceRow): RepoHost {
  if (s.provider === "github") {
    if (!s.installation_id) throw new HostError("the GitHub App is not installed for this repository", 401, false);
    return githubRepo(env, s.installation_id, s.path ?? "", s.project_id);
  }
  if (!s.connected_by) throw new HostError("nobody is connected to this GitLab project", 401, false);
  return gitlabRepo(env, s.project_id, s.connected_by);
}

export const repoUrl = (provider: "github" | "gitlab", path: string) => `https://${provider}.com/${path}`;
