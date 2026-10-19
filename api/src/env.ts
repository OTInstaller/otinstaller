import type { Hono } from "hono";
import { apiError } from "./lib/errors";

export interface Env {
  DB: D1Database;
  PUBLISH_QUEUE: Queue<PublishMessage>;
  SITE_URL: string;
  API_URL: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string;
}

export interface PublishMessage {
  jobId: string;
}

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
