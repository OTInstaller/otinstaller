import type { Hono } from "hono";
import { apiError } from "./lib/errors";

export interface Env {
  DB: D1Database;
  PUBLISH_QUEUE: Queue<PublishMessage>;
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
  OPS_REPO?: string; // e.g. "osintverse/registry-ops", where the scan workflow runs
  OPS_INSTALLATION_ID?: string; // the GitHub App's installation on that repo
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** The queue carries publish jobs and bulk-import detection. */
export type PublishMessage = { jobId: string } | { importId: string };

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
