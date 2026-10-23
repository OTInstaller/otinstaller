// Looking up an `ot_` API token: whose it is and what it may do. The API's authenticate (routes/auth.ts) and the image
// mirror (mirror/registry.ts), which binds the same database, both use this, so the rules can't drift apart.
import type { User } from "../env";
import { sha256Hex } from "./crypto";

export const TOKEN_PREFIX = "ot_";

export type FoundToken = { user: User; tokenId: string; scopes: Set<string>; scoped: boolean; hash: string };

/** The user and scopes behind a live token: not revoked, not expired, and its user not banned. Null otherwise. */
export async function findToken(db: D1Database, token: string, now = Date.now()): Promise<FoundToken | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT u.id, u.login, u.is_admin, u.is_reviewer, t.id AS token_id, t.scopes, t.scoped FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.banned_at IS NULL`,
  ).bind(hash, now).first<User & { token_id: string; scopes: string; scoped: number }>();
  if (!row) return null;
  return {
    user: { id: row.id, login: row.login, is_admin: row.is_admin, is_reviewer: row.is_reviewer },
    tokenId: row.token_id,
    scopes: new Set(row.scopes.split(",")),
    scoped: row.scoped === 1,
    hash,
  };
}

/** Whether a token may do what a scope covers: tokens from before scopes (scoped = 0) can do everything. */
export const hasScope = (t: FoundToken, scope: string) => !t.scoped || t.scopes.has(scope);
