// The registry API, for pages (on the server) and islands (in the browser, with the session cookie).
export const API_URL = String(import.meta.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").replace(/\/+$/, "");
export const SITE_URL = String(import.meta.env.SITE ?? "https://otinstaller.com").replace(/\/+$/, "");
/** The closed beta: shows the beta strip. Build with PUBLIC_BETA=0 at launch. */
export const BETA = String(import.meta.env.PUBLIC_BETA ?? "1") !== "0";
/** Where bug reports go (GitHub issues with a severity). */
export const ISSUES_URL = String(import.meta.env.PUBLIC_ISSUES_URL ?? "https://github.com/OTInstaller/otinstaller/issues").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public hint?: string, public problems?: Problem[]) {
    super(message);
  }
}

export interface Problem {
  code: string;
  path?: string;
  message: string;
  hint?: string;
}

/** Calls /v1{path}; errors carry the API's code and hint. Browser calls send the session cookie. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const browser = typeof window !== "undefined";
  const res = await fetch(`${API_URL}/v1${path}`, {
    ...init,
    credentials: browser ? "include" : undefined,
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; hint?: string; problems?: Problem[]; request_id?: string } } | null;
    const e = body?.error;
    const message = e ? e.message + (e.request_id ? ` (request ID ${e.request_id})` : "") : `The registry answered ${res.status}.`;
    throw new ApiError(res.status, e?.code ?? "http_error", message, e?.hint, e?.problems);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** The same, but a 404 is null (for pages that answer 404 themselves). */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Sign-in goes through the API, which returns to `back` on this site. */
export function signInUrl(provider: "github" | "gitlab" | "osintverse", back: string): string {
  return `${API_URL}/v1/auth/${provider}/login?redirect=${encodeURIComponent(back)}`;
}

// ---------- shapes ----------

export interface ToolSummary {
  namespace: string;
  name: string;
  kind: "tool" | "guide";
  summary: string;
  latest_version: string;
  categories: string[];
  inputs: string[];
  outputs: string[];
  runtime: "docker" | "pipx" | null;
  stars: number;
  installs_30d: number;
  health: "unknown" | "healthy" | "broken" | "not_checked";
  verified: boolean;
  signed: boolean;
  needs_keys: boolean;
  manifest_held_by_registry: boolean;
  community_packaged: boolean;
  source_unavailable: boolean;
  status: string;
  title?: string | null;
  level?: string | null;
  format?: string | null;
  language?: string;
  needs_update?: boolean;
}

export interface Manifest {
  name: string;
  namespace: string;
  version: string;
  summary: string;
  license: string;
  homepage?: string;
  categories: string[];
  tags?: string[];
  inputs?: { name: string; type: string; required: boolean; description?: string; values?: string[]; default?: unknown }[];
  outputs?: { type: string }[];
  runtime?: { kind: string; command: string[]; image?: string; package?: string; output_format: string };
  secrets?: { name: string; required: boolean; description?: string; url?: string }[];
  network?: { egress?: boolean; domains?: string[] };
  ethics?: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean };
  test?: { input: Record<string, unknown> };
  docs?: { root: string; nav: string[] };
  title?: string;
  related_tools?: string[];
}

export interface ToolDetail extends ToolSummary {
  repo_url: string | null;
  homepage: string | null;
  license: string;
  deprecated_message?: string;
  deprecated_replacement?: string;
  manifest: Manifest;
  moved_to?: string;
}

export interface Version {
  version: string;
  status: string;
  scan_status: string;
  published_at: number | null;
  yanked_at: number | null;
  signed: boolean;
}

export interface Scans {
  ref: string;
  version: string;
  scan_status: string;
  signed: boolean;
  signer_identity?: string;
  signer_issuer?: string;
  scans: { kind: string; result: "pass" | "warn" | "fail"; ran_at: number; summary: any }[];
}

export interface NavEntry {
  path: string;
  title: string;
  words: number;
  dead_links: number;
}

export interface GuideDetail extends ToolSummary {
  ref: string;
  version: string;
  status: string;
  published_at: number | null;
  license: string;
  repo_url: string | null;
  topics: string[];
  nav: NavEntry[];
  related_tools: ({ ref: string; available: false } | ({ ref: string; available: true; install: string } & ToolSummary))[];
  checks: { needs_update: boolean; dead_link_ratio: number | null; links: null | { checked: number; dead: number; missing: number } };
}

export interface Page {
  ref: string;
  version: string;
  path: string;
  title: string;
  position: number;
  pages: number;
  body: string;
  toc: { depth: number; id: string; text: string }[];
  prev: { path: string; title: string } | null;
  next: { path: string; title: string } | null;
}

export interface Types {
  inputs: string[];
  outputs: string[];
  categories: string[];
}

export interface SearchResult {
  results: ToolSummary[];
  /** How many match in all (added after the first API release, so older responses may omit it). */
  total?: number;
  next_cursor?: string;
}

export interface Namespace {
  name: string;
  kind: string;
  provider: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
  created_at: number;
  tools: ToolSummary[];
}
