import type { Hono } from "hono";
import { apiError } from "./lib/errors";

export interface Env {
  DB: D1Database;
  PUBLISH_QUEUE: Queue<PublishMessage>;
  CONTENT: R2Bucket; // rendered READMEs, guide pages and tool docs
  SITE_URL: string;
  API_URL: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string; // for the App's install link; defaults to "otinstaller"
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  OPS_REPO?: string; // e.g. "OTInstaller/registry-ops", where the scan workflow runs
  OPS_INSTALLATION_ID?: string; // the GitHub App's installation on that repo
  OPS_DISPATCH_TOKEN?: string; // optional fine-grained token with Contents: write on OPS_REPO only; used instead of the App
  RESEND_API_KEY?: string;
  HEALTH_TOKEN?: string; // shared with the nightly health workflow in registry-ops
  SENTRY_DSN?: string; // optional: errors are reported to Sentry
  SENTRY_ENVIRONMENT?: string;
  EMAIL_FROM?: string;
  CF_URLSCAN_ACCOUNT_ID?: string; // with CF_URLSCAN_TOKEN, guide links are checked with Cloudflare URL Scanner
  CF_URLSCAN_TOKEN?: string;
}

/**
 * The queue carries publish jobs, bulk-import detection, guide content checks (the guide's equivalent
 * of a security scan; `attempt` counts rounds of waiting for URL Scanner) and nightly link checks.
 */
export type PublishMessage =
  | { jobId: string }
  | { importId: string }
  | { checkVersionId: string; attempt?: number }
  | { linkCheckToolId: string };

export interface User {
  id: string;
  login: string;
  is_admin: number;
  is_reviewer: number;
}

export type AppEnv = { Bindings: Env; Variables: { user: User | null } };
export type App = Hono<AppEnv>;

// Outbound HTTP goes through here so tests can stand in for GitHub, GitLab, PyPI and registries.
export const deps: { fetch: typeof fetch } = { fetch: (input, init) => fetch(input, init) };

export function requireSecret(env: Env, name: keyof Env): string {
  const v = env[name];
  if (typeof v !== "string" || v === "") apiError(503, "not_configured", `${name} is not configured on this server`);
  return v;
}
