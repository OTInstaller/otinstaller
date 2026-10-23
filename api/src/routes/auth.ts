// Sign-in with GitHub, GitLab or OSINTverse (web OAuth/OIDC and CLI device flow), sessions, API tokens and /me.
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { deps, requireSecret, type App, type AppEnv, type Env, type User } from "../env";
import { apiError } from "../lib/errors";
import { encrypt, randomToken, sha256Hex, ulid } from "../lib/crypto";
import * as github from "../hosts/github";
import * as gitlab from "../hosts/gitlab";
import * as osintverse from "../hosts/osintverse";
import { authorizeDevice, devicePage, deviceRoutes, pollOsintverseDevice, startOsintverseDevice } from "./device";
import { ALL_SCOPES, enforceScopes, parseScopes, USER_SCOPES } from "../scopes";
import { communityRoles } from "../community";
import { findToken, restrictedRouteAllowed, TOKEN_PREFIX } from "../lib/tokens";

export type Provider = "github" | "gitlab" | "osintverse";
const SESSION_COOKIE = "ot_session";
const STATE_COOKIE = "ot_oauth_state";
// OSINTverse (OIDC) only: the nonce, the PKCE verifier and, for `ot login`, the device login being approved.
const OIDC_COOKIE = "ot_oidc";
const SESSION_TTL = 30 * 24 * 3600 * 1000;

function provider(c: Context<AppEnv>): Provider {
  const p = c.req.param("provider");
  if (p !== "github" && p !== "gitlab" && p !== "osintverse") apiError(404, "unknown_provider", "sign in with github, gitlab or osintverse");
  return p;
}

export function oauthClient(env: Env, p: Provider) {
  if (p === "osintverse") return { id: requireSecret(env, "OSINTVERSE_CLIENT_ID"), secret: requireSecret(env, "OSINTVERSE_CLIENT_SECRET") };
  return p === "github"
    ? { id: requireSecret(env, "GITHUB_CLIENT_ID"), secret: requireSecret(env, "GITHUB_CLIENT_SECRET") }
    : { id: requireSecret(env, "GITLAB_CLIENT_ID"), secret: requireSecret(env, "GITLAB_CLIENT_SECRET") };
}

export const callbackUrl = (env: Env, p: Provider) => `${env.API_URL}/v1/auth/${p}/callback`;
export const osintverseIssuer = (env: Env) => env.OSINTVERSE_ISSUER ?? osintverse.OSINTVERSE_ISSUER;

// Only same-site redirects after sign-in, so the flow cannot be used to bounce users elsewhere.
function safeRedirect(env: Env, target: string | undefined): string {
  const site = new URL(env.SITE_URL);
  if (!target) return `${env.SITE_URL}/dashboard`;
  try {
    const u = new URL(target, env.SITE_URL);
    return u.origin === site.origin ? u.toString() : `${env.SITE_URL}/dashboard`;
  } catch {
    return `${env.SITE_URL}/dashboard`;
  }
}

/** Reads the session cookie or a bearer API token and sets c.var.user. Never rejects by itself. */
export async function authenticate(c: Context<AppEnv>, next: Next) {
  c.set("user", null);
  c.set("token", null);
  const header = c.req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const now = Date.now();
  let user: User | null = null;
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const found = await findToken(c.env.DB, bearer, now);
    // A CI run's token counts only where it may be used (lib/tokens.ts); anywhere else the request is anonymous.
    if (found && (!found.restriction || restrictedRouteAllowed(c.req.method, new URL(c.req.url).pathname))) {
      user = found.user;
      c.set("token", { id: found.tokenId, scopes: found.scopes, scoped: found.scoped, restriction: found.restriction });
      c.executionCtx.waitUntil(c.env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`).bind(now, found.hash).run());
    }
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      user = await c.env.DB.prepare(
        `SELECT u.id, u.login, u.is_admin, u.is_reviewer FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned_at IS NULL`,
      ).bind(await sha256Hex(cookie), now).first<User>();
    }
  }
  c.set("user", user);
  await next();
}

/**
 * The user to link a new sign-in to: only someone signed in with the session cookie. An API token must never
 * link an account, or anyone holding one (even a read-only token) could attach their own GitHub account to
 * its owner and sign in as them.
 */
function linkingUserId(c: Context<AppEnv>): string | null {
  return c.get("token") ? null : (c.get("user")?.id ?? null);
}

export function requireUser(c: Context<AppEnv>): User {
  const u = c.get("user");
  if (!u) apiError(401, "unauthenticated", "sign in first", "run `ot login`, or sign in on otinstaller.com");
  return u;
}

/**
 * Finds or creates the user behind a provider account. When someone is already signed in, the
 * provider account is linked to them instead (one account per provider per user).
 */
export async function signIn(
  env: Env,
  p: Provider,
  who: github.OAuthUser,
  // OSINTverse sign-ins keep no provider token: only the identity is used.
  tokens: { accessToken: string | null; refreshToken?: string | null; expiresAt?: number | null; scopes: string },
  currentUserId: string | null,
): Promise<string> {
  const db = env.DB;
  const now = Date.now();
  const encKey = requireSecret(env, "TOKEN_ENC_KEY");
  const access = tokens.accessToken ? await encrypt(encKey, tokens.accessToken) : null;
  const refresh = tokens.refreshToken ? await encrypt(encKey, tokens.refreshToken) : null;
  const existing = await db.prepare(`SELECT id, user_id FROM accounts WHERE provider = ? AND provider_user_id = ?`).bind(p, who.id).first<{ id: string; user_id: string }>();
  if (existing) {
    if (currentUserId && existing.user_id !== currentUserId) {
      apiError(409, "account_already_linked", `this ${p} account is linked to another OTInstaller user`);
    }
    await db.prepare(
      `UPDATE accounts SET login = ?, email = ?, access_token_enc = COALESCE(?, access_token_enc), refresh_token_enc = COALESCE(?, refresh_token_enc), scopes = ?, expires_at = ? WHERE id = ?`,
    ).bind(who.login, who.email, access, refresh, tokens.scopes, tokens.expiresAt ?? null, existing.id).run();
    return existing.user_id;
  }
  let userId = currentUserId;
  const stmts: D1PreparedStatement[] = [];
  if (!userId) {
    userId = ulid(now);
    // The public handle is the login, made unique across providers with the end of the user's ID.
    stmts.push(db.prepare(
      `INSERT INTO users (id, login, name, email, avatar_url, created_at, handle) VALUES (?1, ?2, ?3, ?4, ?5, ?6,
         CASE WHEN EXISTS (SELECT 1 FROM users WHERE handle = lower(?2)) THEN lower(?2) || '-' || lower(substr(?1, -4)) ELSE lower(?2) END)`,
    ).bind(userId, who.login, who.name, who.email, who.avatarUrl, now));
  } else {
    const has = await db.prepare(`SELECT 1 FROM accounts WHERE user_id = ? AND provider = ?`).bind(userId, p).first();
    if (has) apiError(409, "provider_already_linked", `you already linked a different ${p} account`);
  }
  stmts.push(
    db.prepare(
      `INSERT INTO accounts (id, user_id, provider, provider_user_id, login, email, access_token_enc, refresh_token_enc, scopes, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(ulid(now), userId, p, who.id, who.login, who.email, access, refresh, tokens.scopes, tokens.expiresAt ?? null, now),
    audit(db, userId, "user", currentUserId ? "account.link" : "user.create", "user", userId, { provider: p, login: who.login }),
  );
  await db.batch(stmts);
  return userId;
}

export function audit(db: D1Database, actorId: string | null, actorKind: string, action: string, targetKind: string, targetId: string, meta?: unknown) {
  return db.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_kind, action, target_kind, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(ulid(), actorId, actorKind, action, targetKind, targetId, meta === undefined ? null : JSON.stringify(meta), Date.now());
}

/** Mints a scoped API token; it is returned once and only its hash is kept. */
export async function mintApiToken(db: D1Database, userId: string, name: string, scopes: readonly string[] = USER_SCOPES, expiresAt: number | null = null) {
  const token = TOKEN_PREFIX + randomToken(30);
  const id = ulid();
  await db.batch([
    db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, userId, name, await sha256Hex(token), scopes.join(","), expiresAt, Date.now()),
    audit(db, userId, "user", "token.create", "token", id, { name, scopes, expires_at: expiresAt }),
  ]);
  return { id, token, scopes, expires_at: expiresAt };
}

const DAY = 24 * 3600 * 1000;

/** Reads scopes and expires_in_days from a token request. A token can't mint one with more than it has itself. */
function tokenRequest(c: Context<AppEnv>, body: { scopes?: unknown; expires_in_days?: unknown }, defaultDays: number | null) {
  const scopes = parseScopes(body.scopes);
  const u = c.get("user");
  const t = c.get("token");
  if (scopes.includes("staff") && (!u || (!u.is_admin && !u.is_reviewer) || t)) {
    apiError(403, "insufficient_scope", "only a signed-in reviewer or admin can create a staff token, on the website");
  }
  if (t?.scoped) {
    const extra = scopes.filter((s) => !t.scopes.has(s));
    if (extra.length) apiError(403, "insufficient_scope", `this token can't create a token with ${extra.join(", ")}`, "create it on the website instead");
  }
  let days: number | null = defaultDays;
  if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
    const n = Number(body.expires_in_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) apiError(400, "invalid_body", "expires_in_days is a whole number from 1 to 365");
    days = n;
  }
  return { scopes, expiresAt: days === null ? null : Date.now() + days * DAY };
}

/** Starts a session for a signed-in user (the cookie the site sends to the API). */
async function startSession(c: Context<AppEnv>, userId: string) {
  const session = randomToken(32);
  await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .bind(ulid(), userId, await sha256Hex(session), Date.now() + SESSION_TTL, c.req.header("user-agent")?.slice(0, 200) ?? null).run();
  setCookie(c, SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL / 1000 });
}

/** Redirects to OSINTverse; `device` is the device login `ot login --osintverse` is waiting on, if any. */
export async function osintverseLogin(c: Context<AppEnv>, redirect: string, device: string | null) {
  const client = oauthClient(c.env, "osintverse");
  const d = await osintverse.discover(deps.fetch, osintverseIssuer(c.env));
  const state = randomToken(24);
  const nonce = randomToken(24);
  const { verifier, challenge } = await osintverse.pkce();
  setCookie(c, STATE_COOKIE, `${state}|osintverse|${redirect}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/v1/auth", maxAge: 600 });
  setCookie(c, OIDC_COOKIE, `${nonce}|${verifier}|${device ?? ""}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/v1/auth", maxAge: 600 });
  return c.redirect(osintverse.authorizeUrl(d, { clientId: client.id, redirectUri: callbackUrl(c.env, "osintverse"), state, nonce, challenge }), 302);
}

async function osintverseCallback(c: Context<AppEnv>, state: string | undefined, stateProvider: string | undefined, redirect: string) {
  const [nonce, verifier, device] = (getCookie(c, OIDC_COOKIE) ?? "").split("|");
  deleteCookie(c, OIDC_COOKIE, { path: "/v1/auth" });
  if (!state || state !== c.req.query("state") || stateProvider !== "osintverse" || !nonce || !verifier) {
    apiError(400, "oauth_state_mismatch", "sign-in expired or was tampered with; start again");
  }
  const error = c.req.query("error");
  if (error) {
    // access_denied: the user cancelled on osintverse.com.
    if (device) {
      await c.env.DB.prepare(`UPDATE device_logins SET status = 'denied' WHERE id = ? AND status = 'pending'`).bind(device).run();
      return c.html(devicePage("Sign-in cancelled", "<p>Nothing was shared. You can close this tab; <code>ot login</code> stops waiting.</p>"));
    }
    return c.redirect(`${c.env.SITE_URL}/?signin=${error === "access_denied" ? "cancelled" : "failed"}`, 302);
  }
  const code = c.req.query("code");
  if (!code) apiError(400, "invalid_parameter", "the sign-in response has no code");
  const client = oauthClient(c.env, "osintverse");
  const d = await osintverse.discover(deps.fetch, osintverseIssuer(c.env));
  const t = await osintverse.exchangeCode(deps.fetch, d, { clientId: client.id, clientSecret: client.secret, code, verifier, redirectUri: callbackUrl(c.env, "osintverse") });
  const claims = await osintverse.verifyIdToken(deps.fetch, d, t.idToken, { clientId: client.id, nonce });
  const who = await osintverse.fetchUser(deps.fetch, d, t.accessToken, claims.sub);
  // No automatic linking by email: an existing user links OSINTverse by signing in with it while
  // already signed in, the same rule as GitHub and GitLab. A device login never links.
  const userId = await signIn(c.env, "osintverse", who, { accessToken: null, scopes: osintverse.SCOPES }, device ? null : linkingUserId(c));
  if (device) return authorizeDevice(c, device, userId);
  await startSession(c, userId);
  return c.redirect(safeRedirect(c.env, redirect), 302);
}

export function authRoutes(app: App) {
  app.use("*", authenticate);
  app.use("*", enforceScopes);
  deviceRoutes(app);

  // ---------- web OAuth ----------
  app.get("/auth/:provider/login", async (c) => {
    const p = provider(c);
    const redirect = safeRedirect(c.env, c.req.query("redirect"));
    if (p === "osintverse") return osintverseLogin(c, redirect, null);
    const client = oauthClient(c.env, p);
    const state = randomToken(24);
    setCookie(c, STATE_COOKIE, `${state}|${p}|${redirect}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/v1/auth", maxAge: 600 });
    const url = p === "github"
      ? github.authorizeUrl(client.id, callbackUrl(c.env, p), state)
      : gitlab.authorizeUrl(client.id, callbackUrl(c.env, p), state, c.req.query("scope") === "api");
    return c.redirect(url, 302);
  });

  app.get("/auth/:provider/callback", async (c) => {
    const p = provider(c);
    const [state, stateProvider, ...rest] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
    const redirect = rest.join("|");
    deleteCookie(c, STATE_COOKIE, { path: "/v1/auth" });
    if (p === "osintverse") return osintverseCallback(c, state, stateProvider, redirect);
    const code = c.req.query("code");
    if (!state || state !== c.req.query("state") || stateProvider !== p || !code) {
      apiError(400, "oauth_state_mismatch", "sign-in expired or was tampered with; start again");
    }
    const client = oauthClient(c.env, p);
    const tokens = p === "github"
      ? await github.exchangeCode(deps.fetch, client.id, client.secret, code, callbackUrl(c.env, p))
      : await gitlab.exchangeCode(deps.fetch, client.id, client.secret, code, callbackUrl(c.env, p));
    const who = p === "github" ? await github.fetchUser(deps.fetch, tokens.accessToken) : await gitlab.fetchUser(deps.fetch, tokens.accessToken);
    const userId = await signIn(c.env, p, who, tokens, linkingUserId(c));
    await startSession(c, userId);
    return c.redirect(safeRedirect(c.env, redirect), 302);
  });

  app.post("/auth/logout", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(cookie)).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  // ---------- device flow for `ot login` ----------
  app.post("/auth/device/start", async (c) => {
    const { provider: p = "github" } = await c.req.json<{ provider?: Provider }>().catch(() => ({} as { provider?: Provider }));
    if (p === "osintverse") return c.json(await startOsintverseDevice(c));
    if (p !== "github" && p !== "gitlab") apiError(400, "unknown_provider", "provider must be github, gitlab or osintverse");
    const client = oauthClient(c.env, p);
    const d = p === "github" ? await github.startDeviceFlow(deps.fetch, client.id) : await gitlab.startDeviceFlow(deps.fetch, client.id, client.secret);
    return c.json({ provider: p, device_code: d.deviceCode, user_code: d.userCode, verification_uri: d.verificationUri, interval: d.interval, expires_in: d.expiresIn });
  });

  app.post("/auth/device/token", async (c) => {
    const body = await c.req.json<{ provider?: Provider; device_code?: string; token_name?: string; scopes?: unknown; expires_in_days?: unknown }>().catch(() => ({}) as any);
    const p = body.provider ?? "github";
    if (p === "osintverse" && body.device_code) return c.json(await pollOsintverseDevice(c, body.device_code, body.token_name));
    if ((p !== "github" && p !== "gitlab") || !body.device_code) apiError(400, "invalid_body", "send {provider, device_code}");
    const client = oauthClient(c.env, p);
    const r = p === "github" ? await github.pollDeviceFlow(deps.fetch, client.id, body.device_code) : await gitlab.pollDeviceFlow(deps.fetch, client.id, client.secret, body.device_code);
    if (r.status !== "ok") return c.json({ status: r.status });
    const who = p === "github" ? await github.fetchUser(deps.fetch, r.accessToken) : await gitlab.fetchUser(deps.fetch, r.accessToken);
    const userId = await signIn(c.env, p, who, r, null);
    // `ot login` tokens don't expire unless asked to; they can do what the user can, except staff actions.
    const { scopes, expiresAt } = tokenRequest(c, body, null);
    const { token } = await mintApiToken(c.env.DB, userId, (body.token_name ?? "ot CLI").slice(0, 60), scopes, expiresAt);
    return c.json({ status: "ok", token, login: who.login, provider: p, scopes, expires_at: expiresAt });
  });

  // ---------- me ----------
  app.get("/me", async (c) => {
    const u = requireUser(c);
    const [accounts, namespaces, me, roles] = await Promise.all([
      c.env.DB.prepare(`SELECT provider, login FROM accounts WHERE user_id = ? ORDER BY provider`).bind(u.id).all(),
      c.env.DB.prepare(
        `SELECT n.name, n.status, n.verified, m.role FROM namespace_members m JOIN namespaces n ON n.id = m.namespace_id WHERE m.user_id = ? ORDER BY n.name`,
      ).bind(u.id).all(),
      c.env.DB.prepare(`SELECT handle, profile_hidden, (SELECT COUNT(*) FROM inbox WHERE user_id = users.id AND read_at IS NULL) AS unread FROM users WHERE id = ?`).bind(u.id)
        .first<{ handle: string | null; profile_hidden: number | null; unread: number }>(),
      communityRoles(c.env, u),
    ]);
    return c.json({
      login: u.login, handle: me?.handle ?? u.login.toLowerCase(), admin: u.is_admin === 1, reviewer: u.is_reviewer === 1,
      community_roles: [...roles].sort(), profile_hidden: !!me?.profile_hidden, unread: me?.unread ?? 0, accounts: accounts.results, namespaces: namespaces.results,
    });
  });

  app.get("/me/tokens", async (c) => {
    const u = requireUser(c);
    // The hour-long tokens CI runs get through trusted publishing aren't the user's to manage, so they aren't listed.
    const rows = await c.env.DB.prepare(
      `SELECT id, name, scopes, scoped, expires_at, last_used_at, created_at FROM api_tokens
       WHERE user_id = ? AND namespace_id IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`,
    ).bind(u.id, Date.now()).all<{ id: string; scopes: string; scoped: number }>();
    c.header("Cache-Control", "private, no-store");
    return c.json({
      tokens: rows.results.map((t) => ({
        ...t,
        // Tokens from before scopes can do everything their user can.
        scopes: t.scoped === 1 ? t.scopes.split(",") : [...ALL_SCOPES],
        scoped: t.scoped === 1,
        current: c.get("token")?.id === t.id,
      })),
    });
  });

  app.post("/me/tokens", async (c) => {
    const u = requireUser(c);
    const body = await c.req.json<{ name?: string; scopes?: unknown; expires_in_days?: unknown }>().catch(() => ({}) as { name?: string; scopes?: unknown; expires_in_days?: unknown });
    const name = body.name;
    if (!name?.trim()) apiError(400, "invalid_body", "send {name, scopes?, expires_in_days?}");
    // Tokens made here expire in 90 days unless asked otherwise (at most 365).
    const { scopes, expiresAt } = tokenRequest(c, body, 90);
    const t = await mintApiToken(c.env.DB, u.id, name.trim().slice(0, 60), scopes, expiresAt);
    return c.json({ id: t.id, token: t.token, scopes: t.scopes, expires_at: t.expires_at, note: "This token is shown once." }, 201);
  });

  app.delete("/me/tokens/:id", async (c) => {
    const u = requireUser(c);
    const id = c.req.param("id");
    const r = await c.env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).bind(Date.now(), id, u.id).run();
    if (!r.meta.changes) apiError(404, "token_not_found", "no such token");
    await audit(c.env.DB, u.id, "user", "token.revoke", "token", id, { by_token: c.get("token")?.id ?? null }).run();
    return c.body(null, 204);
  });

  // ---------- publish history ----------
  // Jobs for every namespace the user belongs to: uploads name theirs, GitHub jobs are found through the installation,
  // GitLab jobs through the source. `method` says how the release came in: a tag, an upload from CI, or a direct upload.
  const jobs = (where: string) =>
    `SELECT j.id, j.provider, j.repo, j.tag, j.commit_sha, j.ci_json, j.status, j.error_code, j.error_detail, j.problems_json, j.created_at, j.updated_at,
       CASE WHEN j.provider = 'direct' THEN 'direct' WHEN j.bundle_key IS NOT NULL THEN 'ci' ELSE 'tag' END AS method,
       n.name AS namespace, t.name AS name, v.version, v.status AS version_status, v.scan_status
     FROM publish_jobs j
     LEFT JOIN installations i ON i.github_installation_id = j.installation_id
     LEFT JOIN sources s ON s.id = j.source_id
     JOIN namespace_members m ON m.namespace_id = COALESCE(j.namespace_id, i.namespace_id, s.namespace_id)
     JOIN namespaces n ON n.id = m.namespace_id
     LEFT JOIN tools t ON t.id = j.tool_id
     LEFT JOIN versions v ON v.id = j.version_id
     WHERE m.user_id = ? ${where}`;
  const jobView = (env: Env, j: any) => ({
    ...j,
    ref: j.name ? `${j.namespace}/${j.name}` : null,
    problems: j.problems_json ? JSON.parse(j.problems_json) : [],
    problems_json: undefined,
    // The CI run an upload came from (trusted publishing): workflow, ref, run and actor.
    ci: j.ci_json ? JSON.parse(j.ci_json) : null,
    ci_json: undefined,
    url: `${env.SITE_URL}/dashboard/publish/${j.id}`,
  });

  app.get("/me/publish-jobs", async (c) => {
    const u = requireUser(c);
    const rows = await c.env.DB.prepare(`${jobs("")} ORDER BY j.created_at DESC LIMIT 50`).bind(u.id).all<any>();
    c.header("Cache-Control", "private, no-store");
    return c.json({ jobs: rows.results.map((j) => jobView(c.env, j)) });
  });

  // One job, for `ot publish --wait` and the job page. Someone else's job is "not found", not "forbidden".
  app.get("/me/publish-jobs/:id", async (c) => {
    const u = requireUser(c);
    // A CI run's token follows only its own repository's jobs in its namespace (the App's tag job for the release too).
    const r = c.get("token")?.restriction;
    const j = r
      ? await c.env.DB.prepare(`${jobs("AND j.id = ? AND n.id = ? AND j.provider = ? AND j.repo_id = ?")} LIMIT 1`)
        .bind(u.id, c.req.param("id"), r.namespaceId, r.ci?.provider ?? "", r.ci?.repository_id ?? "").first<any>()
      : await c.env.DB.prepare(`${jobs("AND j.id = ?")} LIMIT 1`).bind(u.id, c.req.param("id")).first<any>();
    if (!j) apiError(404, "not_found", "no such publish job in your namespaces");
    c.header("Cache-Control", "private, no-store");
    return c.json(jobView(c.env, j));
  });
}
