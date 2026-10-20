import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { b64url } from "../src/lib/crypto";
import { loginFrom, resetCaches } from "../src/hosts/osintverse";
import { normalizeCode } from "../src/routes/device";
import { call, cookiesFrom, fakeHosts, testEnv } from "./helpers";
import type { Env } from "../src/env";

const ISSUER = "https://osintverse.com/api/auth";
const CLIENT = "ot-web-client";
let keys: CryptoKeyPair;
let publicJwk: JsonWebKey;

interface Person { sub: string; name?: string; email?: string; email_verified?: boolean; picture?: string }

async function ovEnv(): Promise<Env> {
  return { ...(await testEnv()), OSINTVERSE_CLIENT_ID: CLIENT, OSINTVERSE_CLIENT_SECRET: "ov-secret" };
}

async function idToken(claims: Record<string, unknown>, signer = keys.privateKey, kid = "k1") {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, signer, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/**
 * A fake OSINTverse: the token endpoint checks the client secret and the PKCE verifier, and returns an
 * ID token for `person` (or whatever `tamper` makes of it).
 */
function provider(person: Person, opts: { tamper?: (c: Record<string, unknown>) => Record<string, unknown>; signer?: CryptoKey } = {}) {
  const state: { challenge?: string; nonce?: string; tokenRequests: number } = { tokenRequests: 0 };
  const calls = fakeHosts({
    [`GET ${ISSUER}/.well-known/openid-configuration`]: {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/authorize`, token_endpoint: `${ISSUER}/oauth2/token`,
      userinfo_endpoint: `${ISSUER}/oauth2/userinfo`, jwks_uri: `${ISSUER}/jwks`,
    },
    [`GET ${ISSUER}/jwks`]: { keys: [{ ...publicJwk, kid: "k1", alg: "EdDSA", use: "sig" }] },
    [`POST ${ISSUER}/oauth2/token`]: async (req) => {
      state.tokenRequests++;
      if (req.headers.get("authorization") !== `Basic ${btoa(`${CLIENT}:ov-secret`)}`) return new Response("bad client", { status: 401 });
      const form = new URLSearchParams(await req.text());
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
      if (challenge !== state.challenge || form.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      let claims: Record<string, unknown> = { iss: ISSUER, aud: CLIENT, sub: person.sub, exp: now + 300, iat: now, nonce: state.nonce };
      if (opts.tamper) claims = opts.tamper(claims);
      return { access_token: "opaque-access", token_type: "Bearer", id_token: await idToken(claims, opts.signer) };
    },
    [`GET ${ISSUER}/oauth2/userinfo`]: (req) => (req.headers.get("authorization") === "Bearer opaque-access" ? person : new Response("no", { status: 401 })),
  });
  return { calls, state };
}

/** Follows the redirect to OSINTverse and back, as a browser would after the user agrees. */
async function signInVia(start: Response, p: ReturnType<typeof provider>, e: Env, extraCookie = "", query = "code=good-code") {
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/oauth2/authorize`);
  p.state.challenge = authorize.searchParams.get("code_challenge")!;
  p.state.nonce = authorize.searchParams.get("nonce")!;
  const cookie = [cookiesFrom(start), extraCookie].filter(Boolean).join("; ");
  return call(`/auth/osintverse/callback?${query}&state=${authorize.searchParams.get("state")}`, { headers: { cookie } }, e);
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
});
beforeEach(() => resetCaches());

describe("Sign in with OSINTverse (web)", () => {
  it("signs in with authorization code + PKCE and keeps no OSINTverse token", async () => {
    const e = await ovEnv();
    const p = provider({ sub: "ov-user-1", name: "Ada Lovelace", email: "ada@example.com", email_verified: true, picture: "https://example.com/a.png" });
    const start = await call("/auth/osintverse/login?redirect=/tools", {}, e);
    const authorize = new URL(start.headers.get("location")!);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code", client_id: CLIENT, scope: "openid profile email", code_challenge_method: "S256",
      redirect_uri: "https://api.otinstaller.com/v1/auth/osintverse/callback",
    });
    const res = await signInVia(start, p, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://otinstaller.com/tools");
    const me = (await (await call("/me", { headers: { cookie: cookiesFrom(res) } }, e)).json()) as any;
    expect(me.login).toBe("ada-lovelace");
    expect(me.accounts).toEqual([{ provider: "osintverse", login: "ada-lovelace" }]);
    const acct = await env.DB.prepare(`SELECT email, access_token_enc FROM accounts WHERE provider = 'osintverse' AND provider_user_id = 'ov-user-1'`).first<any>();
    expect(acct).toEqual({ email: "ada@example.com", access_token_enc: null });
    const user = await env.DB.prepare(`SELECT avatar_url FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.provider_user_id = 'ov-user-1'`).first<any>();
    expect(user.avatar_url).toBe("https://example.com/a.png");
  });

  it("finds the same user again by sub, and drops unverified emails", async () => {
    const e = await ovEnv();
    const p = provider({ sub: "ov-user-2", name: "Grace", email: "grace@example.com", email_verified: false });
    await signInVia(await call("/auth/osintverse/login", {}, e), p, e);
    await signInVia(await call("/auth/osintverse/login", {}, e), p, e);
    const rows = await env.DB.prepare(`SELECT email FROM accounts WHERE provider = 'osintverse' AND provider_user_id = 'ov-user-2'`).all<any>();
    expect(rows.results).toEqual([{ email: null }]);
  });

  it("links OSINTverse to the account you're signed in to, never by email", async () => {
    const e = await ovEnv();
    // Someone signed in with GitHub, with the same email as the OSINTverse account below.
    fakeHosts({
      "POST https://github.com/login/oauth/access_token": { access_token: "gho_x", scope: "read:user" },
      "GET https://api.github.com/user/emails": [{ email: "linus@example.com", primary: true, verified: true }],
      "GET https://api.github.com/user": { id: 7001, login: "linus", email: "linus@example.com" },
    });
    const gh = await call("/auth/github/login", {}, e);
    const ghState = new URL(gh.headers.get("location")!).searchParams.get("state");
    const session = cookiesFrom(await call(`/auth/github/callback?code=x&state=${ghState}`, { headers: { cookie: cookiesFrom(gh) } }, e));

    // Signing in with OSINTverse while signed out makes a separate user, even with the same verified email.
    let p = provider({ sub: "ov-user-3", name: "Linus T", email: "linus@example.com", email_verified: true });
    await signInVia(await call("/auth/osintverse/login", {}, e), p, e);
    const separate = await env.DB.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM accounts WHERE provider_user_id IN ('7001', 'ov-user-3')`).first<any>();
    expect(separate.n).toBe(2);

    // Signed in with GitHub, a new OSINTverse account is linked to that user.
    p = provider({ sub: "ov-user-4", name: "Linus T" });
    const linked = await signInVia(await call("/auth/osintverse/login", { headers: { cookie: session } }, e), p, e, session);
    expect(linked.status).toBe(302);
    const me = (await (await call("/me", { headers: { cookie: session } }, e)).json()) as any;
    expect(me.accounts.map((a: any) => a.provider)).toEqual(["github", "osintverse"]);
  });

  it("rejects ID tokens with the wrong nonce, audience, issuer or signature", async () => {
    const e = await ovEnv();
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const cases: Parameters<typeof provider>[1][] = [
      { tamper: (c) => ({ ...c, nonce: "replayed" }) },
      { tamper: (c) => ({ ...c, aud: "someone-else" }) },
      { tamper: (c) => ({ ...c, iss: "https://evil.example" }) },
      { tamper: (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }) },
      { signer: other.privateKey },
    ];
    for (const [i, opts] of cases.entries()) {
      resetCaches();
      const p = provider({ sub: `ov-bad-${i}` }, opts);
      const res = await signInVia(await call("/auth/osintverse/login", {}, e), p, e);
      expect(res.status, `case ${i}`).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("set-cookie") ?? "", `case ${i}`).not.toContain("ot_session=");
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE provider_user_id LIKE 'ov-bad-%'`).first<any>()).n).toBe(0);
  });

  it("rejects a callback without the matching state or PKCE cookie", async () => {
    const e = await ovEnv();
    const p = provider({ sub: "ov-user-5" });
    const start = await call("/auth/osintverse/login", {}, e);
    p.state.challenge = new URL(start.headers.get("location")!).searchParams.get("code_challenge")!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const onlyState = cookiesFrom(start).split("; ").filter((c) => c.startsWith("ot_oauth_state=")).join("; ");
    expect((await call(`/auth/osintverse/callback?code=good-code&state=${state}`, { headers: { cookie: onlyState } }, e)).status).toBe(400);
    expect((await call(`/auth/osintverse/callback?code=good-code&state=forged`, { headers: { cookie: cookiesFrom(start) } }, e)).status).toBe(400);
    expect(p.state.tokenRequests).toBe(0);
  });

  it("sends people who cancel on OSINTverse back to the site", async () => {
    const e = await ovEnv();
    const p = provider({ sub: "ov-user-6" });
    const res = await signInVia(await call("/auth/osintverse/login", {}, e), p, e, "", "error=access_denied");
    expect(res.headers.get("location")).toBe("https://otinstaller.com/?signin=cancelled");
    expect(p.state.tokenRequests).toBe(0);
  });

  it("derives a display login from the name or email", () => {
    expect(loginFrom("Zoë O'Neil", null, "x")).toBe("zoe-o-neil");
    expect(loginFrom(null, "j.doe@example.com", "x")).toBe("j-doe");
    expect(loginFrom("  ", null, "abc_DEF-123456789")).toBe("osintverse-abc-def-1234");
  });
});

describe("ot login --osintverse (device flow)", () => {
  const start = (e: Env) => call("/auth/device/start", { method: "POST", headers: { "content-type": "application/json", "user-agent": "ot/1.0 (linux)" }, body: JSON.stringify({ provider: "osintverse" }) }, e);
  const poll = (e: Env, device_code: string) =>
    call("/auth/device/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "osintverse", device_code, token_name: "ot CLI on test" }) }, e);
  const enterCode = (e: Env, code: string) =>
    call("/auth/osintverse/device", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }).toString() }, e);
  const confirm = (e: Env, page: string, decision: "approve" | "deny", cookie = "") => {
    const id = /name="id" value="([^"]+)"/.exec(page)![1]!;
    const token = /name="confirm" value="([^"]+)"/.exec(page)![1]!;
    return call("/auth/osintverse/device/confirm", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ id, confirm: token, decision }).toString(),
    }, e);
  };

  it("issues an ot_ token after the user types the code, signs in and approves", async () => {
    const e = await ovEnv();
    const d = (await (await start(e)).json()) as any;
    expect(d).toMatchObject({ provider: "osintverse", verification_uri: "https://api.otinstaller.com/v1/auth/osintverse/device", interval: 5, expires_in: 600 });
    expect(d.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(((await (await poll(e, d.device_code)).json()) as any).status).toBe("pending");
    expect(((await (await poll(e, d.device_code)).json()) as any).status).toBe("slow_down");

    expect((await call("/auth/osintverse/device", {}, e)).headers.get("content-type")).toContain("text/html");
    expect((await enterCode(e, "ZZZZ-ZZZZ")).status).toBe(400);
    const p = provider({ sub: "ov-cli-1", name: "Hedy" });
    const page = await (await signInVia(await enterCode(e, d.user_code.toLowerCase().replace("-", " ")), p, e)).text();
    expect(page).toContain("Approve ot on this computer?");
    expect(page).toContain(d.user_code);
    expect(page).toContain("ot/1.0 (linux)");
    expect(page).not.toContain("<script");

    // Signed in but not approved yet: still pending, and no session was started for the device flow.
    await env.DB.prepare(`UPDATE device_logins SET last_polled_at = 0 WHERE user_code = ?`).bind(d.user_code).run();
    expect(((await (await poll(e, d.device_code)).json()) as any).status).toBe("pending");

    expect(await (await confirm(e, page, "approve")).text()).toContain("ot is signed in");
    const ok = (await (await poll(e, d.device_code)).json()) as any;
    expect(ok).toMatchObject({ status: "ok", login: "hedy", provider: "osintverse" });
    expect(ok.token).toMatch(/^ot_/);
    const me = (await (await call("/me", { headers: { authorization: `Bearer ${ok.token}` } }, e)).json()) as any;
    expect(me.accounts).toEqual([{ provider: "osintverse", login: "hedy" }]);
    // The token is handed out once.
    expect(((await (await poll(e, d.device_code)).json()) as any).status).toBe("expired");
    // The approval form cannot be replayed.
    expect((await confirm(e, page, "approve")).status).toBe(410);
  });

  it("reports denial, from the approval page or from OSINTverse", async () => {
    const e = await ovEnv();
    const a = (await (await start(e)).json()) as any;
    const page = await (await signInVia(await enterCode(e, a.user_code), provider({ sub: "ov-cli-2", name: "Ida" }), e)).text();
    expect(await (await confirm(e, page, "deny")).text()).toContain("Sign-in denied");
    expect(((await (await poll(e, a.device_code)).json()) as any).status).toBe("denied");

    const b = (await (await start(e)).json()) as any;
    const cancelled = await signInVia(await enterCode(e, b.user_code), provider({ sub: "ov-cli-3" }), e, "", "error=access_denied");
    expect(await cancelled.text()).toContain("Sign-in cancelled");
    expect(((await (await poll(e, b.device_code)).json()) as any).status).toBe("denied");
  });

  it("needs the confirmation token, and expires codes", async () => {
    const e = await ovEnv();
    const d = (await (await start(e)).json()) as any;
    const page = await (await signInVia(await enterCode(e, d.user_code), provider({ sub: "ov-cli-4", name: "Joan" }), e)).text();
    const forged = page.replace(/name="confirm" value="[^"]+"/, 'name="confirm" value="guessed"');
    expect((await confirm(e, forged, "approve")).status).toBe(410);
    expect(((await (await poll(e, d.device_code)).json()) as any).status).not.toBe("ok");

    const old = (await (await start(e)).json()) as any;
    await env.DB.prepare(`UPDATE device_logins SET expires_at = 1 WHERE user_code = ?`).bind(old.user_code).run();
    expect((await enterCode(e, old.user_code)).status).toBe(400);
    expect(((await (await poll(e, old.device_code)).json()) as any).status).toBe("expired");
    expect(((await (await poll(e, "never-issued")).json()) as any).status).toBe("expired");
  });

  it("normalizes typed codes", () => {
    expect(normalizeCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeCode("BCDF-GHJK")).toBe("BCDF-GHJK");
  });
});
