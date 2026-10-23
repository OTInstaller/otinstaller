// The registry API, for pages (on the server) and islands (in the browser, with the session cookie).
export const API_URL = String(import.meta.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").replace(/\/+$/, "");
export const SITE_URL = String(import.meta.env.SITE ?? "https://otinstaller.com").replace(/\/+$/, "");
/** The closed beta: shows the beta strip. Build with PUBLIC_BETA=0 at launch. */
export const BETA = String(import.meta.env.PUBLIC_BETA ?? "1") !== "0";
/** Where bug reports go (GitHub issues with a severity). */
export const ISSUES_URL = String(import.meta.env.PUBLIC_ISSUES_URL ?? "https://github.com/OTInstaller/feedback/issues").replace(/\/+$/, "");

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
  /** When the nightly health check last ran (ms); null when never. Older API responses omit it. */
  health_checked_at?: number | null;
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
  /** The latest version's ethics flags (added with the agent work; older API responses omit them). */
  ethics?: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean; notifies_target?: boolean };
  /** Whether the latest version's runs have network access. */
  egress?: boolean;
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
  inputs?: { name: string; type: string; required: boolean; description?: string; values?: string[]; default?: unknown; example?: unknown }[];
  outputs?: { type: string; description?: string; attrs?: { name: string; type: string; description?: string }[] }[];
  runtime?: { kind: string; command: string[]; image?: string; package?: string; package_version?: string; wheel_sha256?: string; output_format: string; timeout_seconds?: number; typical_seconds?: number };
  secrets?: { name: string; required: boolean; description?: string; url?: string; pricing?: "free" | "free_tier" | "paid" }[];
  network?: { egress?: boolean; domains?: string[] };
  ethics?: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean; notifies_target?: boolean; notes?: string };
  readme?: string;
  test?: { input: Record<string, unknown>; expect_exit_code?: number };
  docs?: { root: string; nav: string[] };
  /** Guides only: their pages. */
  content?: { root: string; nav: string[] };
  kind?: "tool" | "guide";
  title?: string;
  related_tools?: string[];
}

/** What the latest version's smoke test produced, recorded by the scanner (see the tool page's sample). */
export interface SmokeSample {
  output_format: string;
  entities?: Record<string, unknown>[];
  entity_count?: number;
  stdout?: string;
  version: string;
  recorded_at: number;
}

export interface ToolDetail extends ToolSummary {
  sample?: SmokeSample;
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

/** The manifest endpoint: what `ot install` reads, plus where it falls back to when the original host refuses. */
export interface ManifestResponse {
  ref: string;
  version: string;
  status: string;
  signer_identity?: string;
  signer_issuer?: string;
  scan_status: string;
  health: string;
  verified_publisher: boolean;
  manifest: Manifest | null;
  mirror_image?: string;
  wheel_url?: string;
}

export interface Facets {
  kind: "tool" | "guide";
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  categories: Record<string, number>;
  runtimes: Record<string, number>;
  no_keys: number;
}

export interface Pivots {
  pivots: Record<string, ToolSummary[]>;
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
  /** Which input types each entity type can feed (spec/pivots.json); older API responses omit it. */
  pivots?: Record<string, { input: string; attr?: string; transform?: string }[]>;
}

export interface SearchResult {
  results: ToolSummary[];
  /** How many match in all (added after the first API release, so older responses may omit it). */
  total?: number;
  next_cursor?: string;
}

export interface Social {
  /** x, linkedin, mastodon, bluesky, youtube, github, gitlab, other… */
  provider: string;
  url: string;
}

export interface ProfileHost {
  provider: "github" | "gitlab";
  login: string;
  url: string;
  /** The account the namespace is bound to; the others were linked by an owner. */
  primary: boolean;
}

export interface Profile {
  bio: string | null;
  location: string | null;
  website: string | null;
  company: string | null;
  socials: Social[];
  members: { login: string; avatar_url: string | null; url: string }[];
  hosts: ProfileHost[];
  /** The owner's About section, sanitized by the registry. */
  about_html: string | null;
  pins: string[];
  details_hidden: boolean;
  /** When the account was created on its host. */
  host_since: number | null;
}

export interface NamespaceStats {
  packages: number;
  tools: number;
  guides: number;
  installs_30d: number;
  installs_total: number;
  stars: number;
  healthy: number;
  broken: number;
  last_published_at: number | null;
}

export interface Namespace {
  name: string;
  kind: string;
  provider: string;
  /** active, or pending_review (no packages and nothing the owner wrote are shown). Older API responses omit it. */
  status?: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
  created_at: number;
  /** Older API responses omit the profile and stats. */
  profile?: Profile;
  stats?: NamespaceStats;
  tools: (ToolSummary & { published_at?: number | null })[];
}

export interface ActivityEvent {
  type: "published" | "yanked" | "unyanked" | "deprecated" | "undeprecated" | "transferred";
  ref: string;
  kind: "tool" | "guide";
  at: number;
  version?: string;
  from?: string;
  to?: string;
}

export interface PublisherList {
  namespaces: { name: string; kind: string; verified: boolean; display_name: string; packages: number; installs_30d: number }[];
}

/** GET /me/namespaces/:ns/profile: what the owner's Profile tab edits. */
export interface ProfileSettings {
  namespace: { name: string; kind: string; provider: string; status: string; verified: boolean };
  host: { display_name: string | null; bio: string | null; location: string | null; website: string | null; company: string | null; avatar_url: string | null; socials: Social[]; members: number };
  custom: Partial<Record<ProfileField, unknown>>;
  fields: ProfileField[];
  effective: Profile & { display_name: string; avatar_url: string | null; synced_at: number | null };
  about_md: string | null;
  pins: string[];
  hide_details: boolean;
  sync: { status: "never" | "ok" | "error"; error: string | null; synced_at: number | null };
  hosts: ProfileHost[];
  accounts: { provider: "github" | "gitlab"; login: string }[];
  packages: { name: string; kind: string; summary: string }[];
}

export type ProfileField = "display_name" | "bio" | "location" | "website" | "company" | "avatar_url" | "socials";
