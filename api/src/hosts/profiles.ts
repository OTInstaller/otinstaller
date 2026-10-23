// Public profiles of GitHub users and orgs and GitLab users and groups, for publisher pages. Only what the host shows
// to anyone is read (never an email address), every value is trimmed and capped, and avatars are kept only from hosts
// the site's CSP allows. The sync itself (tokens, merging, storing) is in ../profiles.ts.
import { HostError, GITHUB_API, type Fetch } from "./github";
import { GITLAB } from "./gitlab";

export interface Social {
  /** x, linkedin, mastodon, bluesky, youtube, facebook, instagram, reddit, twitch, npm, hometown or other. */
  provider: string;
  url: string;
}

export interface Member {
  login: string;
  avatar_url: string | null;
  url: string;
}

export interface HostProfile {
  login: string;
  url: string;
  kind: "user" | "org" | "group";
  name: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  company: string | null;
  avatarUrl: string | null;
  socials: Social[];
  members: Member[];
  createdAt: number | null;
}

export const MAX_MEMBERS = 24;
export const MAX_SOCIALS = 8;

/** Avatar hosts the site's img-src allows (web/astro.config.mjs). */
const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "gitlab.com", "secure.gravatar.com"]);

/** Trimmed text with control characters removed and capped at `max`, or null when empty. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/** An http(s) URL (a bare host like "example.com" gets https://), or null. */
export function webUrl(v: unknown): string | null {
  const t = text(v, 300);
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** An avatar URL from a host the site may load images from, or null. */
export function avatarUrl(v: unknown): string | null {
  const u = webUrl(v);
  if (!u) return null;
  const parsed = new URL(u);
  return parsed.protocol === "https:" && AVATAR_HOSTS.has(parsed.hostname) ? u : null;
}

const SOCIAL_HOSTS: [RegExp, string][] = [
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)youtube\.com$/, "youtube"],
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)twitch\.tv$/, "twitch"],
  [/(^|\.)npmjs\.com$/, "npm"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)gitlab\.com$/, "gitlab"],
];

/** Which network a profile link points at; a Mastodon-style /@user path counts as mastodon. */
export function socialProvider(url: string): string {
  const u = new URL(url);
  for (const [re, name] of SOCIAL_HOSTS) if (re.test(u.hostname)) return name;
  if (/^\/@[A-Za-z0-9_.]+\/?$/.test(u.pathname)) return "mastodon";
  return "other";
}

/** A social link from a URL; null unless it is http(s). */
export function social(url: unknown): Social | null {
  const u = webUrl(url);
  return u ? { provider: socialProvider(u), url: u } : null;
}

/** Social links without duplicates (by URL), at most MAX_SOCIALS. */
export function uniqueSocials(list: (Social | null)[]): Social[] {
  const seen = new Set<string>();
  const out: Social[] = [];
  for (const s of list) {
    if (!s) continue;
    const key = s.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SOCIALS) break;
  }
  return out;
}

/** "@user@host" (GitLab's Mastodon field) as a profile URL. */
function mastodonUrl(handle: unknown): string | null {
  const m = typeof handle === "string" ? handle.trim().match(/^@?([A-Za-z0-9_.]+)@([a-z0-9.-]+\.[a-z]{2,})$/i) : null;
  return m ? `https://${m[2]}/@${m[1]}` : null;
}

const handle = (v: unknown) => (typeof v === "string" && /^@?[A-Za-z0-9_.-]{1,60}$/.test(v.trim()) ? v.trim().replace(/^@/, "") : null);
const time = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

async function getJson(f: Fetch, url: string, headers: Record<string, string>, what: string): Promise<any | null> {
  const res = await f(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const transient = res.status >= 500 || res.status === 429 || (res.status === 403 && /rate limit/i.test(body));
    throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, transient);
  }
  return res.json();
}

// ---------- GitHub ----------

const ghHeaders = (token: string | null) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "otinstaller-registry",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** A GitHub user or org by its numeric ID (which survives renames); null when the account is gone. */
export async function githubProfile(f: Fetch, token: string | null, accountId: string): Promise<HostProfile | null> {
  const h = ghHeaders(token);
  const u = await getJson(f, `${GITHUB_API}/user/${encodeURIComponent(accountId)}`, h, "reading the GitHub account");
  if (!u?.login) return null;
  const org = u.type === "Organization";
  // An org's description and links are only on /orgs/{login}.
  const o = org ? ((await getJson(f, `${GITHUB_API}/orgs/${encodeURIComponent(u.login)}`, h, "reading the GitHub org")) ?? {}) : {};
  const src = { ...u, ...o };
  const socials: (Social | null)[] = [];
  if (!org) {
    const list = await getJson(f, `${GITHUB_API}/users/${encodeURIComponent(u.login)}/social_accounts`, h, "reading social accounts").catch(() => null);
    for (const s of Array.isArray(list) ? list : []) socials.push(social(s?.url));
  }
  const tw = handle(src.twitter_username);
  if (tw) socials.push({ provider: "x", url: `https://x.com/${tw}` });
  let members: Member[] = [];
  if (org) {
    const list = await getJson(f, `${GITHUB_API}/orgs/${encodeURIComponent(u.login)}/public_members?per_page=${MAX_MEMBERS}`, h, "reading public members").catch(() => null);
    members = (Array.isArray(list) ? list : [])
      .filter((m) => typeof m?.login === "string")
      .slice(0, MAX_MEMBERS)
      .map((m) => ({ login: m.login, avatar_url: avatarUrl(m.avatar_url), url: `https://github.com/${m.login}` }));
  }
  return {
    login: u.login,
    url: `https://github.com/${u.login}`,
    kind: org ? "org" : "user",
    name: text(src.name, 100),
    bio: text(org ? src.description : src.bio, 400),
    location: text(src.location, 100),
    website: webUrl(src.blog),
    company: org ? null : text(src.company, 100),
    avatarUrl: avatarUrl(src.avatar_url),
    socials: uniqueSocials(socials),
    members,
    createdAt: time(src.created_at),
  };
}

// ---------- GitLab ----------

const glHeaders = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** A GitLab user or group by numeric ID; null when it is gone or not public. */
export async function gitlabProfile(f: Fetch, token: string | null, id: string, kind: "user" | "group"): Promise<HostProfile | null> {
  const h = glHeaders(token);
  if (kind === "group") {
    const g = await getJson(f, `${GITLAB}/api/v4/groups/${encodeURIComponent(id)}?with_projects=false`, h, "reading the GitLab group");
    if (!g?.full_path || (g.visibility && g.visibility !== "public")) return null;
    const list = await getJson(f, `${GITLAB}/api/v4/groups/${encodeURIComponent(id)}/members?per_page=${MAX_MEMBERS}`, h, "reading group members").catch(() => null);
    const members = (Array.isArray(list) ? list : [])
      .filter((m) => typeof m?.username === "string" && (m.state ?? "active") === "active")
      .slice(0, MAX_MEMBERS)
      .map((m) => ({ login: m.username, avatar_url: avatarUrl(m.avatar_url), url: `https://gitlab.com/${m.username}` }));
    return {
      login: g.full_path,
      url: `https://gitlab.com/${g.full_path}`,
      kind: "group",
      name: text(g.name, 100),
      bio: text(g.description, 400),
      location: null,
      website: null,
      company: null,
      avatarUrl: avatarUrl(g.avatar_url),
      socials: [],
      members,
      createdAt: time(g.created_at),
    };
  }
  const u = await getJson(f, `${GITLAB}/api/v4/users/${encodeURIComponent(id)}`, h, "reading the GitLab user");
  if (!u?.username || u.state === "blocked") return null;
  const tw = handle(u.twitter);
  const li = handle(u.linkedin);
  return {
    login: u.username,
    url: `https://gitlab.com/${u.username}`,
    kind: "user",
    name: text(u.name, 100),
    bio: text(u.bio, 400),
    location: text(u.location, 100),
    website: webUrl(u.website_url),
    company: text(u.organization, 100),
    avatarUrl: avatarUrl(u.avatar_url),
    socials: uniqueSocials([
      tw ? { provider: "x", url: `https://x.com/${tw}` } : null,
      li ? { provider: "linkedin", url: `https://www.linkedin.com/in/${li}` } : null,
      social(mastodonUrl(u.mastodon)),
      social(u.bluesky ? `https://bsky.app/profile/${String(u.bluesky).replace(/^@/, "")}` : null),
    ]),
    members: [],
    createdAt: time(u.created_at),
  };
}
