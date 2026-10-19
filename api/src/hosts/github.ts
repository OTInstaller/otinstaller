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

const apiHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
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
