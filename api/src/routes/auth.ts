// Sign-in with GitHub or GitLab (web OAuth and CLI device flow), sessions, API tokens and /me.
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { deps, requireSecret, type App, type AppEnv, type Env, type User } from "../env";
import { apiError } from "../lib/errors";
import { encrypt, randomToken, sha256Hex, ulid } from "../lib/crypto";
import * as github from "../hosts/github";
import * as gitlab from "../hosts/gitlab";

type Provider = "github" | "gitlab";
const SESSION_COOKIE = "ot_session";
const STATE_COOKIE = "ot_oauth_state";
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const TOKEN_PREFIX = "ot_";

function provider(c: Context<AppEnv>): Provider {
  const p = c.req.param("provider");
  if (p !== "github" && p !== "gitlab") apiError(404, "unknown_provider", "sign in with github or gitlab");
  return p;
}

function oauthClient(env: Env, p: Provider) {
  return p === "github"
    ? { id: requireSecret(env, "GITHUB_CLIENT_ID"), secret: requireSecret(env, "GITHUB_CLIENT_SECRET") }
    : { id: requireSecret(env, "GITLAB_CLIENT_ID"), secret: requireSecret(env, "GITLAB_CLIENT_SECRET") };
}

const callbackUrl = (env: Env, p: Provider) => `${env.API_URL}/v1/auth/${p}/callback`;

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
  const header = c.req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const now = Date.now();
  let user: User | null = null;
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const hash = await sha256Hex(bearer);
    user = await c.env.DB.prepare(
      `SELECT u.id, u.login, u.is_admin, u.is_reviewer FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.banned_at IS NULL`,
    ).bind(hash, now).first<User>();
    if (user) c.executionCtx.waitUntil(c.env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`).bind(now, hash).run());
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
  tokens: { accessToken: string; refreshToken?: string | null; expiresAt?: number | null; scopes: string },
  currentUserId: string | null,
): Promise<string> {
  const db = env.DB;
  const now = Date.now();
  const encKey = requireSecret(env, "TOKEN_ENC_KEY");
  const access = await encrypt(encKey, tokens.accessToken);
  const refresh = tokens.refreshToken ? await encrypt(encKey, tokens.refreshToken) : null;
  const existing = await db.prepare(`SELECT id, user_id FROM accounts WHERE provider = ? AND provider_user_id = ?`).bind(p, who.id).first<{ id: string; user_id: string }>();
  if (existing) {
    if (currentUserId && existing.user_id !== currentUserId) {
      apiError(409, "account_already_linked", `this ${p} account is linked to another OTInstaller user`);
    }
    await db.prepare(
      `UPDATE accounts SET login = ?, email = ?, access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), scopes = ?, expires_at = ? WHERE id = ?`,
    ).bind(who.login, who.email, access, refresh, tokens.scopes, tokens.expiresAt ?? null, existing.id).run();
    return existing.user_id;
  }
  let userId = currentUserId;
  const stmts: D1PreparedStatement[] = [];
  if (!userId) {
    userId = ulid(now);
    stmts.push(db.prepare(`INSERT INTO users (id, login, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(userId, who.login, who.name, who.email, who.avatarUrl, now));
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

async function mintApiToken(db: D1Database, userId: string, name: string) {
  const token = TOKEN_PREFIX + randomToken(30);
  const id = ulid();
  await db.prepare(`INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, 'read,publish', ?)`)
    .bind(id, userId, name, await sha256Hex(token), Date.now()).run();
  return { id, token };
}

export function authRoutes(app: App) {
  app.use("*", authenticate);

  // ---------- web OAuth ----------
  app.get("/auth/:provider/login", (c) => {
    const p = provider(c);
    const client = oauthClient(c.env, p);
    const state = randomToken(24);
    const redirect = safeRedirect(c.env, c.req.query("redirect"));
    setCookie(c, STATE_COOKIE, `${state}|${p}|${redirect}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/v1/auth", maxAge: 600 });
    const url = p === "github"
      ? github.authorizeUrl(client.id, callbackUrl(c.env, p), state)
      : gitlab.authorizeUrl(client.id, callbackUrl(c.env, p), state, c.req.query("scope") === "api");
    return c.redirect(url, 302);
  });

  app.get("/auth/:provider/callback", async (c) => {
    const p = provider(c);
    const [state, stateProvider, redirect] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
    deleteCookie(c, STATE_COOKIE, { path: "/v1/auth" });
    const code = c.req.query("code");
    if (!state || state !== c.req.query("state") || stateProvider !== p || !code) {
      apiError(400, "oauth_state_mismatch", "sign-in expired or was tampered with; start again");
    }
    const client = oauthClient(c.env, p);
    const tokens = p === "github"
      ? await github.exchangeCode(deps.fetch, client.id, client.secret, code, callbackUrl(c.env, p))
      : await gitlab.exchangeCode(deps.fetch, client.id, client.secret, code, callbackUrl(c.env, p));
    const who = p === "github" ? await github.fetchUser(deps.fetch, tokens.accessToken) : await gitlab.fetchUser(deps.fetch, tokens.accessToken);
    const userId = await signIn(c.env, p, who, tokens, c.get("user")?.id ?? null);

    const session = randomToken(32);
    await c.env.DB.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)`)
      .bind(ulid(), userId, await sha256Hex(session), Date.now() + SESSION_TTL, c.req.header("user-agent")?.slice(0, 200) ?? null).run();
    setCookie(c, SESSION_COOKIE, session, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL / 1000 });
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
    if (p !== "github" && p !== "gitlab") apiError(400, "unknown_provider", "provider must be github or gitlab");
    const client = oauthClient(c.env, p);
    const d = p === "github" ? await github.startDeviceFlow(deps.fetch, client.id) : await gitlab.startDeviceFlow(deps.fetch, client.id, client.secret);
    return c.json({ provider: p, device_code: d.deviceCode, user_code: d.userCode, verification_uri: d.verificationUri, interval: d.interval, expires_in: d.expiresIn });
  });

  app.post("/auth/device/token", async (c) => {
    const body = await c.req.json<{ provider?: Provider; device_code?: string; token_name?: string }>().catch(() => ({}) as any);
    const p = body.provider ?? "github";
    if ((p !== "github" && p !== "gitlab") || !body.device_code) apiError(400, "invalid_body", "send {provider, device_code}");
    const client = oauthClient(c.env, p);
    const r = p === "github" ? await github.pollDeviceFlow(deps.fetch, client.id, body.device_code) : await gitlab.pollDeviceFlow(deps.fetch, client.id, client.secret, body.device_code);
    if (r.status !== "ok") return c.json({ status: r.status });
    const who = p === "github" ? await github.fetchUser(deps.fetch, r.accessToken) : await gitlab.fetchUser(deps.fetch, r.accessToken);
    const userId = await signIn(c.env, p, who, r, null);
    const { token } = await mintApiToken(c.env.DB, userId, (body.token_name ?? "ot CLI").slice(0, 60));
    return c.json({ status: "ok", token, login: who.login, provider: p });
  });

  // ---------- me ----------
  app.get("/me", async (c) => {
    const u = requireUser(c);
    const [accounts, namespaces] = await Promise.all([
      c.env.DB.prepare(`SELECT provider, login FROM accounts WHERE user_id = ? ORDER BY provider`).bind(u.id).all(),
      c.env.DB.prepare(
        `SELECT n.name, n.status, n.verified, m.role FROM namespace_members m JOIN namespaces n ON n.id = m.namespace_id WHERE m.user_id = ? ORDER BY n.name`,
      ).bind(u.id).all(),
    ]);
    return c.json({ login: u.login, admin: u.is_admin === 1, reviewer: u.is_reviewer === 1, accounts: accounts.results, namespaces: namespaces.results });
  });

  app.get("/me/tokens", async (c) => {
    const u = requireUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT id, name, scopes, last_used_at, created_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    ).bind(u.id).all();
    return c.json({ tokens: rows.results });
  });

  app.post("/me/tokens", async (c) => {
    const u = requireUser(c);
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    if (!name?.trim()) apiError(400, "invalid_body", "send {name}");
    const t = await mintApiToken(c.env.DB, u.id, name.trim().slice(0, 60));
    return c.json({ id: t.id, token: t.token, note: "This token is shown once." }, 201);
  });

  app.delete("/me/tokens/:id", async (c) => {
    const u = requireUser(c);
    const r = await c.env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).bind(Date.now(), c.req.param("id"), u.id).run();
    if (!r.meta.changes) apiError(404, "token_not_found", "no such token");
    return c.body(null, 204);
  });

  // ---------- publish history ----------
  app.get("/me/publish-jobs", async (c) => {
    const u = requireUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT j.id, j.repo, j.tag, j.status, j.error_code, j.problems_json, j.created_at, j.updated_at
       FROM publish_jobs j JOIN installations i ON i.github_installation_id = j.installation_id
       JOIN namespace_members m ON m.namespace_id = i.namespace_id
       WHERE m.user_id = ? ORDER BY j.created_at DESC LIMIT 50`,
    ).bind(u.id).all<any>();
    return c.json({ jobs: rows.results.map((j) => ({ ...j, problems: j.problems_json ? JSON.parse(j.problems_json) : [], problems_json: undefined })) });
  });
}
