// Sign in with OSINTverse: a standard OpenID Connect provider (authorization code + PKCE, EdDSA ID tokens).
// Only identity is used; OSINTverse access tokens are never stored or handed to the CLI. Discovery, keys and the
// signature check are shared with the CI issuers in lib/oidc.ts.
import { b64url } from "../lib/crypto";
import * as oidc from "../lib/oidc";
import { HostError, type Fetch, type OAuthUser } from "./github";

export const OSINTVERSE_ISSUER = "https://osintverse.com/api/auth";
export const SCOPES = "openid profile email";

export interface Discovery extends oidc.Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/** Clears the caches (tests use different fake providers). */
export const resetCaches = oidc.resetOidcCaches;

const check = oidc.check;

export function discover(f: Fetch, issuer = OSINTVERSE_ISSUER): Promise<Discovery> {
  return oidc.discover<Discovery>(f, issuer, "OSINTverse");
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

export interface IdClaims { sub: string; iss: string; aud: string | string[]; exp: number; iat?: number; nonce?: string; azp?: string }

/** Verifies an EdDSA (Ed25519) ID token: signature, issuer, audience, expiry and nonce. */
export async function verifyIdToken(f: Fetch, d: Discovery, token: string, o: { clientId: string; nonce: string; now?: number }): Promise<IdClaims> {
  // OSINTverse's own token endpoint handed the token over, so a malformed one is its fault (502).
  const c = await oidc.verifySignature<IdClaims>(f, d, token, { algs: ["EdDSA"], label: "OSINTverse", status: 502 });
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
