// GitLab.com: OAuth sign-in and device flow. Project webhooks and imports come in week 6.
import { HostError, deviceStatus, type Fetch, type OAuthUser } from "./github";

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
  permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null };
}

export const MAINTAINER = 40;
export const OWNER = 50;

export async function getProject(f: Fetch, token: string, project: string): Promise<GitlabProject | null> {
  const res = await f(`${GITLAB}/api/v4/projects/${encodeURIComponent(project)}`, { headers: { Authorization: `Bearer ${token}` } });
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
