// Sign in with OSINTverse: a standard OpenID Connect provider (authorization code + PKCE, EdDSA ID tokens).
// Only identity is used; OSINTverse access tokens are never stored or handed to the CLI.
import { b64url } from "../lib/crypto";
import { HostError, type Fetch, type OAuthUser } from "./github";

export const OSINTVERSE_ISSUER = "https://osintverse.com/api/auth";
export const SCOPES = "openid profile email";

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

interface Jwk { kty: string; crv?: string; x?: string; kid?: string; alg?: string; use?: string }

// Per isolate: discovery and keys change rarely, so they are cached for an hour (keys are refetched
// at once when an ID token names a key we don't have).
const TTL = 3600_000;
let discoveryCache: { at: number; issuer: string; value: Discovery } | null = null;
let jwksCache: { at: number; uri: string; keys: Jwk[] } | null = null;

/** Clears the caches (tests use different fake providers). */
export function resetCaches() {
  discoveryCache = null;
  jwksCache = null;
}

async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
}

export async function discover(f: Fetch, issuer = OSINTVERSE_ISSUER): Promise<Discovery> {
  if (discoveryCache && discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < TTL) return discoveryCache.value;
  const d = (await (await check(await f(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } }), "OSINTverse discovery")).json()) as Discovery;
  if (d.issuer !== issuer) throw new HostError(`OSINTverse discovery names issuer ${d.issuer}, expected ${issuer}`, 502, false);
  discoveryCache = { at: Date.now(), issuer, value: d };
  return d;
}

/** A PKCE pair (RFC 7636, S256). */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function authorizeUrl(d: Discovery, o: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string }): string {
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri, scope: SCOPES,
    state: o.state, nonce: o.nonce, code_challenge: o.challenge, code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export async function exchangeCode(f: Fetch, d: Discovery, o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }) {
  const res = await f(d.token_endpoint, {
    method: "POST",
    headers: {
      // client_secret_basic: both parts are form-encoded first (RFC 6749 §2.3.1).
      Authorization: `Basic ${btoa(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier }).toString(),
  });
  const t = (await (await check(res, "OSINTverse token exchange")).json()) as { access_token?: string; id_token?: string };
  if (!t.access_token || !t.id_token) throw new HostError("OSINTverse returned no access or ID token", 502, false);
  return { accessToken: t.access_token, idToken: t.id_token };
}

function decodePart<T>(part: string): T {
  const s = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)))) as T;
}

function fromB64url(part: string): Uint8Array {
  const s = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function keys(f: Fetch, uri: string, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < TTL) return jwksCache.keys;
  const body = (await (await check(await f(uri, { headers: { Accept: "application/json" } }), "OSINTverse JWKS")).json()) as { keys?: Jwk[] };
  jwksCache = { at: Date.now(), uri, keys: body.keys ?? [] };
  return jwksCache.keys;
}

export interface IdClaims { sub: string; iss: string; aud: string | string[]; exp: number; iat?: number; nonce?: string; azp?: string }

/** Verifies an EdDSA (Ed25519) ID token: signature, issuer, audience, expiry and nonce. */
export async function verifyIdToken(f: Fetch, d: Discovery, token: string, o: { clientId: string; nonce: string; now?: number }): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HostError("the OSINTverse ID token is malformed", 502, false);
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]!);
  if (header.alg !== "EdDSA") throw new HostError(`the OSINTverse ID token uses ${header.alg}, not EdDSA`, 502, false);
  const find = (ks: Jwk[]) => ks.find((k) => k.kty === "OKP" && k.crv === "Ed25519" && (!header.kid || k.kid === header.kid));
  const jwk = find(await keys(f, d.jwks_uri, false)) ?? find(await keys(f, d.jwks_uri, true));
  if (!jwk) throw new HostError("no OSINTverse signing key matches the ID token", 502, false);
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HostError("the OSINTverse ID token signature is invalid", 401, false);

  const c = decodePart<IdClaims>(parts[1]!);
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  const problems = [
    c.iss !== d.issuer && "issuer",
    !aud.includes(o.clientId) && "audience",
    aud.length > 1 && c.azp !== o.clientId && "authorized party",
    !(typeof c.exp === "number" && c.exp + 60 > now) && "expiry",
    c.nonce !== o.nonce && "nonce",
    !c.sub && "subject",
  ].filter(Boolean);
  if (problems.length) throw new HostError(`the OSINTverse ID token failed its ${problems.join(", ")} check`, 401, false);
  return c;
}

interface UserInfo { sub: string; name?: string; given_name?: string; family_name?: string; picture?: string; email?: string; email_verified?: boolean }

/** The profile behind a verified sub. Emails are only kept when OSINTverse has verified them. */
export async function fetchUser(f: Fetch, d: Discovery, accessToken: string, sub: string): Promise<OAuthUser & { emailVerified: boolean }> {
  const u = (await (await check(await f(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }), "OSINTverse userinfo")).json()) as UserInfo;
  if (u.sub !== sub) throw new HostError("OSINTverse userinfo is for a different user than the ID token", 401, false);
  const name = u.name?.trim() || [u.given_name, u.family_name].filter(Boolean).join(" ").trim() || null;
  const verified = u.email_verified === true && !!u.email;
  return { id: sub, login: loginFrom(name, verified ? u.email! : null, sub), name, email: verified ? u.email! : null, avatarUrl: u.picture ?? null, emailVerified: verified };
}

/**
 * OSINTverse accounts have no username, so the registry shows one made from the name or email.
 * It is a display name only: namespaces still come from GitHub and GitLab.
 */
export function loginFrom(name: string | null, email: string | null, sub: string): string {
  const slug = (s: string) => s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 39);
  return slug(name ?? "") || slug(email?.split("@")[0] ?? "") || `osintverse-${slug(sub).slice(0, 12)}`;
}
