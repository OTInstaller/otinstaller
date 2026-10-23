// The registry API, for pages (on the server) and islands (in the browser, with the session cookie).
export const API_URL = String(import.meta.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").replace(/\/+$/, "");
export const SITE_URL = String(import.meta.env.SITE ?? "https://otinstaller.com").replace(/\/+$/, "");
/** The closed beta: shows the beta strip. Build with PUBLIC_BETA=0 at launch. */
export const BETA = String(import.meta.env.PUBLIC_BETA ?? "1") !== "0";
/** Where bug reports go (GitHub issues with a severity). */
export const ISSUES_URL = String(import.meta.env.PUBLIC_ISSUES_URL ?? "https://github.com/OTInstaller/feedback/issues").replace(/\/+$/, "");

export class ApiError extends Error {
  /** Fields the error adds beyond code, message and hint (a request's number, the package that exists, ...). */
  constructor(public status: number, public code: string, message: string, public hint?: string, public problems?: Problem[], public extra: Record<string, unknown> = {}) {
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
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; hint?: string; problems?: Problem[]; request_id?: string } & Record<string, unknown> } | null;
    const e = body?.error;
    const message = e ? e.message + (e.request_id ? ` (request ID ${e.request_id})` : "") : `The registry answered ${res.status}.`;
    const { code: _c, message: _m, hint: _h, problems: _p, docs: _d, ...extra } = (e ?? {}) as Record<string, unknown>;
    throw new ApiError(res.status, e?.code ?? "http_error", message, e?.hint, e?.problems, extra);
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
  /** Open issues people filed; older API answers omit it. */
  community?: { open_broken: number; open_outdated: number };
  /** What the upstream watcher last found, for community wrappers. */
  upstream?: UpstreamWatch;
  /** The handle of whoever submitted a community package (community submissions). */
  packaged_by?: string;
  /** People who look after a community package besides its namespace. */
  maintainers?: string[];
}

export interface Version {
  version: string;
  status: string;
  scan_status: string;
  published_at: number | null;
  yanked_at: number | null;
  signed: boolean;
  /** Release notes as Markdown: untrusted text, never rendered as HTML. Absent from older API answers. */
  changelog?: string | null;
  /** The same notes, rendered and sanitized by the registry. */
  changelog_html?: string | null;
  /** Where the notes came from: the host's release for the tag, or the version's section of CHANGELOG.md. */
  changelog_source?: "release" | "file" | null;
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

// ---------- community ----------

export type IssueKind = "broken" | "outdated" | "wrong_info" | "feature" | "question";
export type IssueStatus = "open" | "confirmed" | "fixed" | "wont_fix" | "duplicate";

export interface IssueAuthor {
  handle: string;
  avatar_url?: string | null;
  system?: boolean;
  profile?: boolean;
}

export interface IssueSummary {
  number: number;
  kind: IssueKind;
  status: IssueStatus;
  title: string;
  author: IssueAuthor;
  version: string | null;
  platform: string | null;
  comments: number;
  me_too: number;
  locked: boolean;
  created_at: number;
  last_activity_at: number;
  closed_at: number | null;
  indexable: boolean;
  /** On the registry-wide board only. */
  ref?: string;
}

export interface IssueList {
  ref: string;
  counts: { open: number; closed: number };
  issues: IssueSummary[];
  next_before: number | null;
}

export interface IssueComment {
  id: string;
  author: IssueAuthor;
  role: "maintainer" | "triager" | "staff" | null;
  body_html: string;
  created_at: number;
  edited_at: number | null;
}

export interface IssueThread {
  ref: string;
  issue: IssueSummary & { id: string; body_html: string; engine: string | null; exit_code: number | null; fixed_in: string | null; duplicate_of: number | null; deleted: boolean; edited_at: number | null };
  comments: IssueComment[];
}

export interface IssueViewer {
  can_triage: boolean;
  is_author: boolean;
  can_edit_issue: boolean;
  editable_comments: string[];
  subscribed: boolean;
  held_comments: { id: string; created_at: number; body_html: string }[];
}

export interface CommunityStatus {
  ref: string;
  version: string | null;
  line: { state: "working" | "mixed" | "failing" | "unknown"; text: string };
  health: { status: string; checked_at: number | null; history: { at: number; version: string; result: "pass" | "fail"; duration_ms: number | null; failure: string | null }[] };
  confirmations: { version: string | null; works: number; broken: number; platforms: Record<string, { works: number; broken: number }> };
  issues: { open_broken: number; open_outdated: number };
}

// ---------- tool requests ----------

export type RequestStatus = "open" | "accepted" | "in_progress" | "published" | "declined";
export type DeclineCode = "license" | "archived" | "not_osint" | "not_cli" | "needs_login" | "acceptable_use" | "unmaintained" | "duplicate" | "withdrawn" | "other";

export interface ToolRequest {
  number: number;
  provider: "github" | "gitlab";
  repo: string;
  name: string;
  url: string;
  description: string | null;
  license: string | null;
  upstream_stars: number | null;
  status: RequestStatus;
  decline_code: DeclineCode | null;
  votes: number;
  requested_by: IssueAuthor | null;
  /** The published package that answers it. */
  tool: string | null;
  /** otlite's name for the tool, when otlite installs it. */
  otlite: string | null;
  created_at: number;
  updated_at: number;
  indexable: boolean;
}

export interface ToolRequestDetail extends ToolRequest {
  note: string | null;
  decision_note: string | null;
  decided_at: number | null;
  decided_by: string | null;
  dropped_reason: string | null;
  pushed_at: number | null;
}

export interface RequestBoard {
  requests: ToolRequest[];
  counts: Record<RequestStatus, number>;
  next_before: string | null;
}

export interface RequestViewer {
  voted: boolean;
  is_requester: boolean;
  can_decide: boolean;
  held: boolean;
  /** The requester's own note while a moderator hasn't looked at it yet. */
  note?: string | null;
}

// ---------- contributor profiles ----------

export interface Person {
  handle: string;
  avatar_url: string | null;
  /** YYYY-MM */
  joined: string;
  roles: ("staff" | "triager" | "reviewer")[];
  counts: { issues_opened: number; issues_confirmed: number; replies: number; confirmations: number; requests_made: number; requests_published: number; issues_triaged: number };
  counted_at: number | null;
  issues: { ref: string; number: number; kind: IssueKind; status: IssueStatus; title: string; created_at: number }[];
  requests: { number: number; repo: string; status: RequestStatus; created_at: number }[];
  indexable: boolean;
}

// ---------- community submissions ----------

export type SubmissionStatus = "submitted" | "releasing" | "in_review" | "changes_requested" | "published" | "rejected" | "withdrawn" | "failed";

export interface Submission {
  number: number;
  name: string;
  upstream: { provider: "github" | "gitlab"; repo: string; url: string };
  runtime: "docker" | "pipx";
  builds: boolean;
  status: SubmissionStatus;
  submitted_by: string | null;
  wrapper_repo: string | null;
  tool: string | null;
  request: number | null;
  created_at: number;
  updated_at: number;
}

export interface SubmissionCheck { code: string; message: string }

export interface SubmissionDetail extends Submission {
  manifest: Record<string, unknown>;
  dockerfile: string | null;
  template_conformant: boolean;
  flags: SubmissionCheck[];
  dockerfile_checks: SubmissionCheck[];
  released_version: string | null;
  decision_note: string | null;
  reviewer: string | null;
  error: string | null;
  release: { version: string; status: string; scan_status: string | null; scans: { kind: string; result: string; summary: unknown }[] } | null;
}

export interface SubmissionViewer { is_submitter: boolean; can_review: boolean; can_edit: boolean }

// ---------- the upstream watcher ----------

export interface UpstreamWatch {
  state: "current" | "behind" | "unknown" | "archived" | "gone" | "license_changed" | "renamed" | "error";
  pinned: string | null;
  latest: string | null;
  latest_at: number | null;
  /** For commit pins: how many commits upstream's default branch has moved on. */
  commits_behind: number | null;
  checked_at: number | null;
  /** The community bot's open pull request bumping the pin, on the tool detail only. */
  bump?: { version: string; number: number; url: string };
}

export interface UpstreamSummary {
  mode: "report" | "issues";
  counts: Record<UpstreamWatch["state"], number>;
  behind: (UpstreamWatch & { ref: string })[];
  checked_at: number | null;
}
