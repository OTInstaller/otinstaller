// Publisher profiles: syncing a namespace's public GitHub or GitLab profile (and its linked secondary hosts), the
// owner's overrides, pins and About section, and what the public page shows. Host calls are in hosts/profiles.ts;
// routes are in routes/profiles.ts and GET /namespaces/:ns in index.ts.
import { deps, requireSecret, type Env } from "./env";
import { apiError } from "./lib/errors";
import { installationToken } from "./hosts/github";
import { githubUserToken, gitlabToken } from "./hosts/repo";
import { avatarUrl, githubProfile, gitlabProfile, social, text, uniqueSocials, webUrl, MAX_MEMBERS, type HostProfile, type Member, type Social } from "./hosts/profiles";
import { renderPage } from "./content";

/** How often the cron refreshes a profile from its hosts (the same pace as source sync). */
export const PROFILE_SYNC_INTERVAL = 6 * 3600 * 1000;
export const MANUAL_PROFILE_SYNCS_PER_HOUR = 10;
export const MAX_PINS = 6;
export const MAX_ABOUT = 20_000;

/** Fields the owner can override; everything else on the page comes from the registry. */
export const PROFILE_FIELDS = ["display_name", "bio", "location", "website", "company", "avatar_url", "socials"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type NamespaceRow = {
  id: string;
  name: string;
  provider: "github" | "gitlab" | "registry";
  provider_owner_id: string;
  kind: "user" | "org" | "group";
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  verified: number;
  created_at: number;
};

export type ProfileRow = {
  namespace_id: string;
  host_login: string | null;
  host_url: string | null;
  host_name: string | null;
  host_bio: string | null;
  host_location: string | null;
  host_website: string | null;
  host_company: string | null;
  host_avatar_url: string | null;
  host_socials_json: string;
  host_members_json: string;
  host_created_at: number | null;
  custom_json: string;
  about_md: string | null;
  about_html: string | null;
  pins_json: string;
  hide_details: number;
  sync_status: "never" | "ok" | "error";
  sync_error: string | null;
  synced_at: number | null;
  updated_at: number;
};

export type HostLink = { provider: "github" | "gitlab"; provider_owner_id: string; login: string; kind: "user" | "org" | "group"; linked_by: string | null; created_at: number };

export const NAMESPACE_COLUMNS = `id, name, provider, provider_owner_id, kind, display_name, avatar_url, status, verified, created_at`;

export async function namespaceByName(env: Env, name: string) {
  return env.DB.prepare(`SELECT ${NAMESPACE_COLUMNS} FROM namespaces WHERE name = ?`).bind(name).first<NamespaceRow>();
}

export async function profileOf(env: Env, namespaceId: string) {
  return env.DB.prepare(`SELECT * FROM namespace_profiles WHERE namespace_id = ?`).bind(namespaceId).first<ProfileRow>();
}

export async function hostsOf(env: Env, namespaceId: string) {
  return (await env.DB.prepare(`SELECT provider, provider_owner_id, login, kind, linked_by, created_at FROM namespace_hosts WHERE namespace_id = ? ORDER BY provider`)
    .bind(namespaceId).all<HostLink>()).results;
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ---------- tokens ----------

/**
 * The best GitHub token for reading a namespace's account: its GitHub App installation, else a member's sign-in token
 * (the given user's first), else none (anonymous calls work for public profiles, at a lower rate limit).
 */
async function githubTokenFor(env: Env, namespaceId: string, userId?: string | null): Promise<string | null> {
  try {
    const inst = await env.DB.prepare(`SELECT github_installation_id FROM installations WHERE namespace_id = ? AND suspended_at IS NULL LIMIT 1`)
      .bind(namespaceId).first<{ github_installation_id: number }>();
    if (inst && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
      return await installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), inst.github_installation_id);
    }
  } catch {
    // Fall through to a member's token.
  }
  for (const id of await memberIds(env, namespaceId, "github", userId)) {
    try {
      return await githubUserToken(env, id);
    } catch {
      // Try the next member.
    }
  }
  return null;
}

async function gitlabTokenFor(env: Env, namespaceId: string, userId?: string | null): Promise<string | null> {
  for (const id of await memberIds(env, namespaceId, "gitlab", userId)) {
    try {
      return await gitlabToken(env, id);
    } catch {
      // Revoked or expired: try the next member.
    }
  }
  return null;
}

/** Members with an account on the provider, the preferred user first. */
async function memberIds(env: Env, namespaceId: string, provider: string, prefer?: string | null): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT m.user_id FROM namespace_members m JOIN accounts a ON a.user_id = m.user_id AND a.provider = ? WHERE m.namespace_id = ?
     ORDER BY m.role = 'owner' DESC LIMIT 5`,
  ).bind(provider, namespaceId).all<{ user_id: string }>();
  const ids = rows.results.map((r) => r.user_id);
  return prefer ? [prefer, ...ids.filter((i) => i !== prefer)] : ids;
}

async function readHost(env: Env, namespaceId: string, provider: "github" | "gitlab", ownerId: string, kind: string, userId?: string | null) {
  if (provider === "github") return githubProfile(deps.fetch, await githubTokenFor(env, namespaceId, userId), ownerId);
  return gitlabProfile(deps.fetch, await gitlabTokenFor(env, namespaceId, userId), ownerId, kind === "group" ? "group" : "user");
}

// ---------- sync ----------

/** The first value that is set, across the primary host and then the secondary ones. */
const first = <T>(list: (HostProfile | null)[], pick: (p: HostProfile) => T | null): T | null => {
  for (const p of list) {
    const v = p ? pick(p) : null;
    if (v !== null && v !== undefined) return v;
  }
  return null;
};

/**
 * Refreshes a namespace's profile from its hosts and stores it. Never throws: a failure is recorded on the profile
 * (sync_status error) and the values from the last good sync stay.
 */
export async function syncProfile(env: Env, namespaceId: string, userId?: string | null): Promise<{ status: "ok" | "error"; error?: string }> {
  const db = env.DB;
  const now = Date.now();
  const ns = await db.prepare(`SELECT ${NAMESPACE_COLUMNS} FROM namespaces WHERE id = ?`).bind(namespaceId).first<NamespaceRow>();
  if (!ns) return { status: "error", error: "no such namespace" };
  await db.prepare(`INSERT INTO namespace_profiles (namespace_id, updated_at) VALUES (?, ?) ON CONFLICT (namespace_id) DO NOTHING`).bind(ns.id, now).run();
  const errors: string[] = [];
  let primary: HostProfile | null = null;
  if (ns.provider === "github" || ns.provider === "gitlab") {
    try {
      primary = await readHost(env, ns.id, ns.provider, ns.provider_owner_id, ns.kind, userId);
      if (!primary) errors.push(`the ${ns.provider === "github" ? "GitHub" : "GitLab"} account is gone or not public`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const secondary: HostProfile[] = [];
  const renames: D1PreparedStatement[] = [];
  const linked = await hostsOf(env, ns.id);
  for (const h of linked) {
    try {
      const p = await readHost(env, ns.id, h.provider, h.provider_owner_id, h.kind, h.linked_by);
      if (!p) {
        errors.push(`the linked ${h.provider} account ${h.login} is gone or not public`);
        continue;
      }
      secondary.push(p);
      if (p.login !== h.login) renames.push(db.prepare(`UPDATE namespace_hosts SET login = ? WHERE namespace_id = ? AND provider = ?`).bind(p.login, ns.id, h.provider));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const all = [primary, ...secondary];
  // With no host left at all (a registry namespace whose last linked host was removed), the host values are cleared.
  const fetched = all.some(Boolean) || (ns.provider === "registry" && linked.length === 0);
  const stmts: D1PreparedStatement[] = [...renames];
  if (fetched) {
    const socials = uniqueSocials(all.flatMap((p) => p?.socials ?? []));
    const seen = new Set<string>();
    const members: Member[] = [];
    for (const m of all.flatMap((p) => p?.members ?? [])) {
      if (seen.has(m.url) || members.length >= MAX_MEMBERS) continue;
      seen.add(m.url);
      members.push(m);
    }
    stmts.push(db.prepare(
      `UPDATE namespace_profiles SET host_login = ?, host_url = ?, host_name = ?, host_bio = ?, host_location = ?, host_website = ?, host_company = ?,
         host_avatar_url = ?, host_socials_json = ?, host_members_json = ?, host_created_at = ? WHERE namespace_id = ?`,
    ).bind(
      primary?.login ?? null, primary?.url ?? null, first(all, (p) => p.name), first(all, (p) => p.bio), first(all, (p) => p.location),
      first(all, (p) => p.website), first(all, (p) => p.company), first(all, (p) => p.avatarUrl), JSON.stringify(socials), JSON.stringify(members),
      first(all, (p) => p.createdAt), ns.id,
    ));
  }
  const status = errors.length ? "error" : "ok";
  stmts.push(db.prepare(`UPDATE namespace_profiles SET sync_status = ?, sync_error = ?, synced_at = ?, updated_at = ? WHERE namespace_id = ?`)
    .bind(status, errors.length ? errors.join("; ").slice(0, 500) : null, now, now, ns.id));
  await db.batch(stmts);
  await syncNamespaceAvatar(env, ns.id);
  return status === "ok" ? { status } : { status, error: errors.join("; ") };
}

/** Keeps namespaces.avatar_url (used outside the profile) equal to the profile's avatar. */
async function syncNamespaceAvatar(env: Env, namespaceId: string) {
  const p = await profileOf(env, namespaceId);
  if (!p) return;
  const custom = json<Record<string, unknown>>(p.custom_json, {});
  const avatar = "avatar_url" in custom ? (custom.avatar_url as string | null) : p.host_avatar_url;
  if (avatar) await env.DB.prepare(`UPDATE namespaces SET avatar_url = ? WHERE id = ?`).bind(avatar, namespaceId).run();
}

/** Cron: refresh profiles that were never synced or are older than PROFILE_SYNC_INTERVAL, oldest first. */
export async function refreshDueProfiles(env: Env, now = Date.now(), limit = 10) {
  const due = await env.DB.prepare(
    `SELECT n.id FROM namespaces n LEFT JOIN namespace_profiles p ON p.namespace_id = n.id
     WHERE n.status IN ('active', 'pending_review') AND (n.provider != 'registry' OR EXISTS (SELECT 1 FROM namespace_hosts h WHERE h.namespace_id = n.id))
       AND (p.synced_at IS NULL OR p.synced_at < ?)
     ORDER BY p.synced_at IS NOT NULL, p.synced_at LIMIT ?`,
  ).bind(now - PROFILE_SYNC_INTERVAL, limit).all<{ id: string }>();
  for (const r of due.results) await syncProfile(env, r.id);
  return due.results.length;
}

// ---------- what the page shows ----------

export interface PublicHost {
  provider: "github" | "gitlab";
  login: string;
  url: string;
  primary: boolean;
}

const hostUrl = (provider: string, login: string) => `https://${provider}.com/${login}`;

/** The hosts a profile links to: the namespace's own account first, then the linked secondary ones. */
export function publicHosts(ns: NamespaceRow, p: ProfileRow | null, hosts: HostLink[]): PublicHost[] {
  const out: PublicHost[] = [];
  if (ns.provider === "github" || ns.provider === "gitlab") {
    const login = p?.host_login ?? ns.display_name ?? ns.name;
    out.push({ provider: ns.provider, login, url: p?.host_url ?? hostUrl(ns.provider, login), primary: true });
  }
  for (const h of hosts) out.push({ provider: h.provider, login: h.login, url: hostUrl(h.provider, h.login), primary: false });
  return out;
}

/** The values the page shows: an override when the owner set one, else the host's. Hidden details come back empty. */
export function effectiveProfile(ns: NamespaceRow, p: ProfileRow | null, hosts: HostLink[]) {
  const custom = json<Record<string, unknown>>(p?.custom_json, {});
  const pick = <T>(field: ProfileField, host: T): T => (field in custom ? (custom[field] as T) : host);
  const hide = p?.hide_details === 1;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    display_name: str(pick("display_name", p?.host_name)) ?? ns.display_name ?? ns.name,
    avatar_url: str(pick("avatar_url", p?.host_avatar_url)) ?? ns.avatar_url ?? null,
    bio: hide ? null : str(pick("bio", p?.host_bio)),
    location: hide ? null : str(pick("location", p?.host_location)),
    website: hide ? null : str(pick("website", p?.host_website)),
    company: hide ? null : str(pick("company", p?.host_company)),
    socials: hide ? [] : (pick<Social[]>("socials", json<Social[]>(p?.host_socials_json, [])) ?? []),
    members: hide ? [] : json<Member[]>(p?.host_members_json, []),
    hosts: publicHosts(ns, p, hosts),
    about_html: p?.about_html ?? null,
    pins: json<string[]>(p?.pins_json, []),
    details_hidden: hide,
    host_since: hide ? null : (p?.host_created_at ?? null),
    synced_at: p?.synced_at ?? null,
  };
}

// ---------- owner edits ----------

/** Validates one override; null clears it (the host value is used again). */
export function overrideValue(field: string, v: unknown): unknown {
  if (!(PROFILE_FIELDS as readonly string[]).includes(field)) apiError(400, "invalid_body", `unknown profile field ${field}; fields are ${PROFILE_FIELDS.join(", ")}`);
  if (v === null) return null;
  const bad = (what: string): never => apiError(400, "invalid_body", `${field} ${what}`);
  switch (field as ProfileField) {
    case "display_name":
    case "location":
    case "company":
      if (typeof v !== "string") bad("must be text");
      return text(v, 100) ?? "";
    case "bio":
      if (typeof v !== "string") bad("must be text");
      return text(v, 400) ?? "";
    case "website": {
      if (v === "") return "";
      return webUrl(v) ?? bad("must be an http(s) URL");
    }
    case "avatar_url": {
      if (v === "") return "";
      return avatarUrl(v) ?? bad("must be a GitHub, GitLab or Gravatar avatar URL");
    }
    case "socials": {
      if (!Array.isArray(v) || v.length > 8) bad("must be a list of up to 8 URLs");
      const list = (v as unknown[]).map((u) => social(u) ?? bad(`has an entry that is not an http(s) URL: ${String(u).slice(0, 80)}`));
      return uniqueSocials(list);
    }
  }
}

/** Renders the About section: Markdown to sanitized HTML, no raw HTML, no images, relative links go to the site. */
export function renderAbout(env: Env, ns: string, md: string): { html: string; problems: { code: string; message: string }[] } {
  const r = renderPage(md, {
    file: "ABOUT.md",
    root: "",
    pages: new Set(),
    pageUrl: (p) => `${env.SITE_URL}/${ns}/${p}`,
    fileUrl: (p) => `${env.SITE_URL}/${ns}/${p.replace(/\.md$/i, "")}`,
    strict: false,
    allowHtml: false,
  });
  // Images would load from the site under the namespace's path, which serves pages, not files: keep the alt text.
  const html = r.html.replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/g, "$1");
  return { html, problems: r.problems.filter((p) => p.code !== "content_image_type").map((p) => ({ code: p.code, message: p.message })) };
}
