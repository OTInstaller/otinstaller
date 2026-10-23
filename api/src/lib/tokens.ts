// Looking up an `ot_` API token: whose it is and what it may do. The API's authenticate (routes/auth.ts) and the image
// mirror (mirror/registry.ts), which binds the same database, both use this, so the rules can't drift apart.
import type { User } from "../env";
import { sha256Hex } from "./crypto";

export const TOKEN_PREFIX = "ot_";

/**
 * A token minted for a CI run (trusted publishing, trusted.ts) only publishes into one namespace, and one package when
 * `pkg` is set. `ci` is where the run ran, from its ID token.
 */
export type Restriction = {
  namespaceId: string;
  pkg: string | null;
  publisherId: string | null;
  ci: { provider: "github" | "gitlab"; repository: string; repository_id: string; ref: string; ref_type: string; sha: string; workflow: string; run: string } | null;
};

export type FoundToken = { user: User; tokenId: string; scopes: Set<string>; scoped: boolean; hash: string; restriction: Restriction | null };

/** The user and scopes behind a live token: not revoked, not expired, and its user not banned. Null otherwise. */
export async function findToken(db: D1Database, token: string, now = Date.now()): Promise<FoundToken | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT u.id, u.login, u.is_admin, u.is_reviewer, t.id AS token_id, t.scopes, t.scoped, t.namespace_id, t.package, t.trusted_publisher_id, t.oidc_json
     FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.banned_at IS NULL`,
  ).bind(hash, now).first<User & {
    token_id: string; scopes: string; scoped: number; namespace_id: string | null; package: string | null; trusted_publisher_id: string | null; oidc_json: string | null;
  }>();
  if (!row) return null;
  return {
    user: { id: row.id, login: row.login, is_admin: row.is_admin, is_reviewer: row.is_reviewer },
    tokenId: row.token_id,
    scopes: new Set(row.scopes.split(",")),
    scoped: row.scoped === 1,
    hash,
    restriction: row.namespace_id
      ? { namespaceId: row.namespace_id, pkg: row.package, publisherId: row.trusted_publisher_id, ci: row.oidc_json ? JSON.parse(row.oidc_json) : null }
      : null,
  };
}

/** Whether a token may do what a scope covers: tokens from before scopes (scoped = 0) can do everything. */
export const hasScope = (t: FoundToken, scope: string) => !t.scoped || t.scopes.has(scope);

/**
 * What a restricted (CI) token may be used for: uploading a release and following its job. Anywhere else the request
 * counts as anonymous, so a leaked CI token reads only what everyone can.
 */
export function restrictedRouteAllowed(method: string, path: string): boolean {
  const p = path.replace(/^\/v1/, "");
  return (method === "POST" && p === "/publish") || (method === "GET" && /^\/me\/publish-jobs\/[^/]+$/.test(p));
}
