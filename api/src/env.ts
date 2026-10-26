// The Worker's environment: its bindings, vars and secrets (Env), the queue's messages (PublishMessage), the signed-in
// user, deps.fetch (every outbound request goes through it, so tests can fake hosts) and helpers for secrets and origins.
import type { Hono } from "hono";
import { apiError } from "./lib/errors";

export interface Env {
  DB: D1Database;
  PUBLISH_QUEUE: Queue<PublishMessage>;
  CONTENT: R2Bucket; // rendered READMEs, guide pages and tool docs
  BACKUPS: R2Bucket; // git bundles (git/...) and wheels (wheels/...)
  MIRROR: R2Bucket; // the image mirror's storage, shared with the mirror Worker (takedowns hide and delete images here)
  MIRROR_HOST?: string; // defaults to mirror.otinstaller.com
  // What the upstream watcher does (upstream.ts): "report" (the default) records what it finds, "issues" also opens
  // and closes outdated issues on community wrappers, "prs" also opens bump pull requests (bumps.ts), and "auto" also
  // merges and releases pin-only bumps a week after upstream's release.
  UPSTREAM_WATCH?: string;
  // Whether the build watcher (build-watch.ts) rebuilds a package on a newer base image when its scan found fixable
  // critical or high vulnerabilities: "rebuild", or "report" (the default) to only record base image changes.
  REBUILD_WATCH?: string;
  BACKUPS_BUCKET?: string; // the BACKUPS bucket's name, for presigned URLs; defaults to otinstaller-backups
  R2_ACCOUNT_ID?: string; // with R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, uploads and downloads go straight to R2
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  SITE_URL: string;
  API_URL: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string; // for the App's install link; defaults to "otinstaller"
  // The community bot: a second GitHub App installed only on osintverse-community, which creates wrapper repositories
  // for community submissions and starts their releases (submissions.ts). Without all three, submitting answers 503.
  COMMUNITY_APP_ID?: string;
  COMMUNITY_APP_PRIVATE_KEY?: string;
  COMMUNITY_INSTALLATION_ID?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  OSINTVERSE_CLIENT_ID?: string; // Sign in with OSINTverse (OIDC); the client is confidential
  OSINTVERSE_CLIENT_SECRET?: string;
  OSINTVERSE_ISSUER?: string; // defaults to https://osintverse.com/api/auth
  TOKEN_ENC_KEY?: string;
  OPS_REPO?: string; // e.g. "OTInstaller/registry-ops", where the scan workflow runs
  OPS_INSTALLATION_ID?: string; // the GitHub App's installation on that repo
  OPS_DISPATCH_TOKEN?: string; // optional fine-grained token with Contents: write on OPS_REPO only; used instead of the App
  RESEND_API_KEY?: string;
  SENTRY_DSN?: string; // optional: errors are reported to Sentry
  SENTRY_ENVIRONMENT?: string;
  EMAIL_FROM?: string;
  CF_URLSCAN_ACCOUNT_ID?: string; // with CF_URLSCAN_TOKEN, guide links are checked with Cloudflare URL Scanner
  CF_URLSCAN_TOKEN?: string;
  ISSUES_REPO?: string; // where beta bug reports are filed; defaults to OTInstaller/feedback
  ISSUES_TOKEN?: string; // optional token with Issues: read, needed to count sev-1 issues while that repository is private
  EDGE_CACHE?: string; // "off" sends every anonymous read to D1 (the tests do this)
  // IndexNow (indexnow.ts): the key the site serves at /<key>.txt; unset or empty sends nothing.
  INDEXNOW_KEY?: string;
}

/**
 * The queue carries publish jobs, bulk-import detection, guide content checks (the guide's equivalent
 * of a security scan; `attempt` counts rounds of waiting for URL Scanner), nightly link checks and the
 * releases a reviewer approved with their namespace (published one per message, not all in one request), and
 * backups of versions published without a scanner run to do them (approved releases, guides).
 */
export type PublishMessage =
  | { jobId: string }
  | { importId: string }
  | { checkVersionId: string; attempt?: number }
  | { linkCheckToolId: string }
  | { publishVersionId: string }
  | { backupVersionId: string }
  | { profileNamespaceId: string }
  | { upstreamCheckToolId: string }
  // The nightly check of one package's dependencies and base image (build-watch.ts).
  | { buildCheckToolId: string }
  // The nightly clean-up of one mirror repository publishers pushed to (backups.ts:sweepMirrorRepo).
  | { mirrorSweepRepo: string };

export interface User {
  id: string;
  login: string;
  is_admin: number;
  is_reviewer: number;
}

// token is set when the request was made with an API token (with its scopes), not the session cookie.
export type AppEnv = { Bindings: Env; Variables: { user: User | null; token: import("./scopes").TokenInfo | null } };
export type App = Hono<AppEnv>;

// Outbound HTTP goes through here so tests can stand in for GitHub, GitLab, PyPI and registries.
export const deps: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export function requireSecret(env: Env, name: keyof Env): string {
  const v = env[name];
  if (typeof v !== "string" || v === "") apiError(503, "not_configured", `${name} is not configured on this server`);
  return v;
}

/** The site's origins: SITE_URL and its www. twin (the site answers on both), for credentialed CORS. */
export function siteOrigins(siteUrl: string): string[] {
  const u = new URL(siteUrl);
  const other = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  return [u.origin, `${u.protocol}//${other}${u.port ? `:${u.port}` : ""}`];
}
