// API token scopes: what a token may do (docs/agent-friendly-plan.md, section 6.3). The session cookie has every
// power its user has. A scoped token has only the scopes it was minted with; staff powers need the staff scope, which
// only a signed-in reviewer or admin can mint, from the website. Tokens from before scopes (scoped = 0) keep every
// power. The middleware also audits every write a token makes, so a leaked agent token can be traced.
import type { Context, Next } from "hono";
import type { AppEnv } from "./env";
import { apiError } from "./lib/errors";
import { audit } from "./routes/auth";

export const USER_SCOPES = ["read", "publish", "manage", "feedback"] as const;
export const ALL_SCOPES: readonly string[] = [...USER_SCOPES, "staff"];

export type TokenInfo = { id: string; scopes: Set<string>; scoped: boolean };

/** What each scope allows, for messages and docs. */
export const SCOPE_HELP: Record<string, string> = {
  read: "your account, tokens and publish history (/me)",
  publish: "imports, manifest edits, syncs and sources",
  manage: "yanks, deprecations, claims, transfers, backup settings and tokens",
  feedback: "reports, feedback, issues and comments",
  staff: "the review queue and admin actions (reviewers and admins only)",
};

/** Parses a scopes list from a request: an array or a comma-separated string, always including read. */
export function parseScopes(input: unknown): string[] {
  if (input === undefined || input === null) return [...USER_SCOPES];
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : null;
  if (!list || list.some((s) => typeof s !== "string")) apiError(400, "invalid_body", "scopes is a list such as [\"read\", \"publish\"]");
  const scopes = new Set((list as string[]).map((s) => s.trim()).filter(Boolean));
  for (const s of scopes) {
    if (!ALL_SCOPES.includes(s)) apiError(400, "invalid_scope", `unknown scope ${s}; scopes are ${ALL_SCOPES.join(", ")}`);
  }
  scopes.add("read");
  return ALL_SCOPES.filter((s) => scopes.has(s));
}

/** The scope a request needs when it is made with a token, or null when tokens don't apply. */
export function requiredScope(method: string, path: string): string | null {
  const p = path.replace(/^\/v1/, "");
  if (/^\/(auth|internal|webhooks)\//.test(p) || p === "/installs" || p === "/health" || p === "/unsubscribe") return null;
  if (p.startsWith("/admin")) return "staff";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  // Taking part: reports, feedback, issues, comments, confirmations, subscriptions and flags. Triage is "manage".
  if (p === "/feedback" || p === "/flags" || /^\/comments\/[^/]+$/.test(p)) return "feedback";
  if (/^\/tools\/[^/]+\/[^/]+\/(reports|confirmations|run-reports|issues(\/\d+(\/(comments|subscription))?)?)$/.test(p)) return "feedback";
  if (/^\/(imports|sources)(\/|$)/.test(p) || /^\/packages\/[^/]+\/[^/]+\/(manifest|sync|source)(\/|$)/.test(p)) return "publish";
  return "manage";
}

/** Refuses a token request outside its scopes, and audits the writes tokens make. Runs after authenticate. */
export async function enforceScopes(c: Context<AppEnv>, next: Next) {
  const t = c.get("token");
  const need = t ? requiredScope(c.req.method, new URL(c.req.url).pathname) : null;
  if (t?.scoped && need && !t.scopes.has(need)) {
    const body = {
      error: {
        code: "insufficient_scope",
        message: `this token has no ${need} scope (${SCOPE_HELP[need]})`,
        hint: need === "staff" ? "use the website while signed in" : `create a token with it: \`ot token create --scope ${need}\``,
        docs: "https://otinstaller.com/docs/errors#insufficient_scope",
        required_scope: need,
      },
    };
    return c.json(body, 403, { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${need}"` });
  }
  await next();
  const u = c.get("user");
  if (t && u && need && need !== "read" && c.res.status < 400) {
    c.executionCtx.waitUntil(
      audit(c.env.DB, u.id, "user", "token.write", "token", t.id, { method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status }).run(),
    );
  }
}
