// GitHub: OAuth sign-in, device flow, and the GitHub App calls the publishing pipeline needs.
import { signJwtRS256 } from "../lib/crypto";

export type Fetch = typeof fetch;

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

export class HostError extends Error {
  constructor(message: string, readonly status: number, readonly transient: boolean) {
    super(message);
  }
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  // Rate limits and server errors are worth retrying; other errors are final.
  const transient = res.status >= 500 || res.status === 429 || (res.status === 403 && /rate limit/i.test(body));
  throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, transient);
}

// An empty token reads public data anonymously (tool requests from people without a linked GitHub account).
const apiHeaders = (token: string): Record<string, string> => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "otinstaller-registry",
});

export interface OAuthUser {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

// ---------- OAuth (web) ----------

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "read:user user:email read:org");
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

type TokenResponse = { access_token?: string; scope?: string; error?: string; error_description?: string };

export async function exchangeCode(f: Fetch, clientId: string, clientSecret: string, code: string, redirectUri: string) {
  const res = await check(
    await f(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "otinstaller-registry" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    }),
    "GitHub token exchange",
  );
  const t = (await res.json()) as TokenResponse;
  if (!t.access_token) throw new HostError(`GitHub sign-in failed: ${t.error_description ?? t.error ?? "no token"}`, 400, false);
  return { accessToken: t.access_token, scopes: t.scope ?? "" };
}

export async function fetchUser(f: Fetch, token: string): Promise<OAuthUser> {
  const u = (await (await check(await f(`${GITHUB_API}/user`, { headers: apiHeaders(token) }), "GitHub /user")).json()) as any;
  let email: string | null = u.email ?? null;
  if (!email) {
    const res = await f(`${GITHUB_API}/user/emails`, { headers: apiHeaders(token) });
    if (res.ok) {
      const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
  }
  return { id: String(u.id), login: u.login, name: u.name ?? null, email, avatarUrl: u.avatar_url ?? null };
}

// ---------- device flow (CLI) ----------

export async function startDeviceFlow(f: Fetch, clientId: string) {
  const res = await check(
    await f(`${GITHUB_WEB}/login/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "otinstaller-registry" },
      body: JSON.stringify({ client_id: clientId, scope: "read:user user:email read:org" }),
    }),
    "GitHub device code",
  );
  const d = (await res.json()) as any;
  return { deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, interval: d.interval ?? 5, expiresIn: d.expires_in };
}

/** Returns the token, or a pending/slow_down/expired/denied status while the user has not finished. */
export async function pollDeviceFlow(f: Fetch, clientId: string, deviceCode: string) {
  const res = await check(
    await f(`${GITHUB_WEB}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "otinstaller-registry" },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    }),
    "GitHub device token",
  );
  const t = (await res.json()) as TokenResponse;
  if (t.access_token) return { status: "ok" as const, accessToken: t.access_token, scopes: t.scope ?? "" };
  return { status: deviceStatus(t.error) };
}

export function deviceStatus(error?: string): "pending" | "slow_down" | "expired" | "denied" {
  if (error === "slow_down") return "slow_down";
  if (error === "expired_token") return "expired";
  if (error === "access_denied") return "denied";
  return "pending";
}

// ---------- GitHub App ----------

export async function appJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift
  return signJwtRS256(privateKeyPem, { iat, exp: iat + 9 * 60, iss: appId });
}

export async function installationToken(f: Fetch, appId: string, privateKeyPem: string, installationId: number): Promise<string> {
  const jwt = await appJwt(appId, privateKeyPem);
  const res = await check(
    await f(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: apiHeaders(jwt) }),
    "GitHub installation token",
  );
  return ((await res.json()) as { token: string }).token;
}

/** The commit a tag points to (dereferencing annotated tags). */
export async function tagCommit(f: Fetch, token: string, repo: string, tag: string): Promise<string> {
  const res = await check(await f(`${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(tag)}`, { headers: apiHeaders(token) }), `resolving tag ${tag}`);
  return ((await res.json()) as { sha: string }).sha;
}

/** Raw file contents at a commit, or null when the file does not exist. */
export async function fileAt(f: Fetch, token: string, repo: string, path: string, sha: string): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
  const res = await f(url, { headers: { ...apiHeaders(token), Accept: "application/vnd.github.raw+json" } });
  if (res.status === 404) return null;
  await check(res, `reading ${path}`);
  return res.text();
}

/** A file's bytes at a ref (images); null when it does not exist. */
export async function fileBytes(f: Fetch, token: string, repo: string, path: string, sha: string): Promise<Uint8Array | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
  const res = await f(url, { headers: { ...apiHeaders(token), Accept: "application/vnd.github.raw+json" } });
  if (res.status === 404) return null;
  await check(res, `reading ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

export type CommitState = "pending" | "success" | "failure" | "error";

export async function setCommitStatus(f: Fetch, token: string, repo: string, sha: string, state: CommitState, description: string, targetUrl: string) {
  await check(
    await f(`${GITHUB_API}/repos/${repo}/statuses/${sha}`, {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ state, context: "otinstaller/publish", description: description.slice(0, 140), target_url: targetUrl }),
    }),
    "setting commit status",
  );
}

// ---------- import wizard ----------

export interface GithubRepo {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string;
  description: string | null;
  topics?: string[];
  license?: { spdx_id: string | null } | null;
  private: boolean;
  archived: boolean;
  stargazers_count?: number;
  pushed_at?: string | null;
  owner: { login: string; id: number; type: string };
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface FileChange {
  path: string;
  content: string;
}

/** A repository as the given token sees it, or null when it does not exist or is hidden. */
export async function getRepo(f: Fetch, token: string, repo: string): Promise<GithubRepo | null> {
  // A numeric ID survives renames and transfers.
  const url = /^\d+$/.test(repo) ? `${GITHUB_API}/repositories/${repo}` : `${GITHUB_API}/repos/${repo}`;
  const res = await f(url, { headers: apiHeaders(token) });
  if (res.status === 404 || res.status === 403) return null;
  await check(res, "reading repository");
  return (await res.json()) as GithubRepo;
}

/** Public repositories the signed-in user owns or belongs to through an org (first 300). */
export async function listUserRepos(f: Fetch, token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await check(
      await f(`${GITHUB_API}/user/repos?affiliation=owner,organization_member&visibility=public&sort=pushed&per_page=100&page=${page}`, { headers: apiHeaders(token) }),
      "listing repositories",
    );
    const batch = (await res.json()) as GithubRepo[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** The user's role in an org ("admin" or "member"), or null when they are not an active member. */
export async function orgRole(f: Fetch, token: string, org: string): Promise<"admin" | "member" | null> {
  const res = await f(`${GITHUB_API}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: apiHeaders(token) });
  if (res.status === 404 || res.status === 403) return null;
  await check(res, "reading org membership");
  const m = (await res.json()) as { state: string; role: string };
  return m.state === "active" ? (m.role === "admin" ? "admin" : "member") : null;
}

/** Files and folders directly inside `dir` ("" for the root), or null when it does not exist. */
export async function listDir(f: Fetch, token: string, repo: string, dir: string, ref: string): Promise<DirEntry[] | null> {
  const path = dir ? `/${dir.split("/").map(encodeURIComponent).join("/")}` : "";
  const res = await f(`${GITHUB_API}/repos/${repo}/contents${path}?ref=${encodeURIComponent(ref)}`, { headers: apiHeaders(token) });
  if (res.status === 404) return null;
  await check(res, `listing ${dir || "the repository root"}`);
  const body = (await res.json()) as { name: string; type: string }[] | object;
  if (!Array.isArray(body)) return null;
  return body.map((e) => ({ name: e.name, type: e.type === "dir" ? "dir" : "file" }));
}

export async function listTags(f: Fetch, token: string, repo: string): Promise<string[]> {
  const res = await check(await f(`${GITHUB_API}/repos/${repo}/tags?per_page=100`, { headers: apiHeaders(token) }), "listing tags");
  return ((await res.json()) as { name: string }[]).map((t) => t.name);
}

function base64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Commits files to `branch` (created from, or reset to, the default branch) and opens a pull request,
 * or returns the one already open from that branch. Needs the App's Contents, Workflows and Pull
 * requests write permissions.
 */
export async function openPullRequest(
  f: Fetch, token: string, repo: string, base: string, branch: string, files: FileChange[], title: string, body: string,
): Promise<{ url: string; number: number }> {
  const json = { ...apiHeaders(token), "Content-Type": "application/json" };
  const head = await check(await f(`${GITHUB_API}/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`, { headers: apiHeaders(token) }), "reading the default branch");
  const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
  const created = await f(`${GITHUB_API}/repos/${repo}/git/refs`, { method: "POST", headers: json, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  if (created.status === 422) {
    // The branch is left over from an earlier attempt: start it again from the default branch.
    await check(
      await f(`${GITHUB_API}/repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", headers: json, body: JSON.stringify({ sha, force: true }) }),
      "resetting the import branch",
    );
  } else {
    await check(created, "creating the import branch");
  }
  for (const file of files) {
    const url = `${GITHUB_API}/repos/${repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const existing = await f(`${url}?ref=${encodeURIComponent(branch)}`, { headers: apiHeaders(token) });
    const prior = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;
    await check(
      await f(url, { method: "PUT", headers: json, body: JSON.stringify({ message: `Add ${file.path} for the OTInstaller Registry`, content: base64(file.content), branch, sha: prior }) }),
      `committing ${file.path}`,
    );
  }
  const pr = await f(`${GITHUB_API}/repos/${repo}/pulls`, { method: "POST", headers: json, body: JSON.stringify({ title, head: branch, base, body, maintainer_can_modify: true }) });
  if (pr.status === 422) {
    const owner = repo.split("/")[0];
    const open = await check(
      await f(`${GITHUB_API}/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, { headers: apiHeaders(token) }),
      "finding the open pull request",
    );
    const first = ((await open.json()) as { html_url: string; number: number }[])[0];
    if (first) return { url: first.html_url, number: first.number };
  }
  const p = (await (await check(pr, "opening the pull request")).json()) as { html_url: string; number: number };
  return { url: p.html_url, number: p.number };
}
