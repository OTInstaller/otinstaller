// Publisher profile pages (/<ns>): sorting and filtering packages, labels for hosts and social links, the schema.org
// Person or Organization, and the Markdown twin (/<ns>.md) that llms.txt links to.
import { SITE_URL, type ActivityEvent, type Namespace, type Social } from "./api";
import { formatCount, formatDate } from "./format";
import { textOf } from "./html";

export type ProfileTab = "packages" | "guides" | "activity";
export type ProfileSort = "installs" | "updated" | "name";
export type KindFilter = "all" | "tool" | "guide";

/** Reads ?tab, ?sort and ?kind, falling back to the defaults for anything unknown. */
export function profileQuery(url: URL): { tab: ProfileTab; sort: ProfileSort; kind: KindFilter } {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = url.searchParams.get(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  return {
    tab: pick("tab", ["packages", "guides", "activity"] as const, "packages"),
    sort: pick("sort", ["installs", "updated", "name"] as const, "installs"),
    kind: pick("kind", ["all", "tool", "guide"] as const, "all"),
  };
}

type Pkg = Namespace["tools"][number];

/** Packages in the chosen order: most installed (then stars), most recently published, or by name. */
export function sortPackages<T extends Pkg>(list: T[], sort: ProfileSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const out = [...list];
  if (sort === "name") return out.sort(byName);
  if (sort === "updated") return out.sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0) || byName(a, b));
  return out.sort((a, b) => b.installs_30d - a.installs_30d || b.stars - a.stars || byName(a, b));
}

const SOCIAL_LABELS: Record<string, string> = {
  x: "X", linkedin: "LinkedIn", mastodon: "Mastodon", bluesky: "Bluesky", youtube: "YouTube", facebook: "Facebook", instagram: "Instagram",
  reddit: "Reddit", twitch: "Twitch", npm: "npm", github: "GitHub", gitlab: "GitLab",
};

/** "Mastodon", "X"…; other links are labelled by their host name. */
export function socialLabel(s: Social): string {
  if (SOCIAL_LABELS[s.provider]) return SOCIAL_LABELS[s.provider]!;
  try {
    return new URL(s.url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

/** A link shown without its scheme and trailing slash: "example.org/me". */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export const hostName = (provider: string) => (provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : provider);

export function kindLabel(kind: string, provider?: string): string {
  if (kind === "user") return "User";
  if (kind === "group") return "Group";
  return provider === "gitlab" ? "Group" : "Organization";
}

/** What the activity tab says for one event, without the date, split around the package so it can be a link. */
export function activityParts(e: ActivityEvent): { before: string; after: string } {
  const v = e.version ? ` v${e.version}` : "";
  switch (e.type) {
    case "published": return { before: "Published ", after: v };
    case "yanked": return { before: "Yanked ", after: v };
    case "unyanked": return { before: "Restored ", after: v };
    case "deprecated": return { before: "Deprecated ", after: "" };
    case "undeprecated": return { before: "Took back the deprecation of ", after: "" };
    case "transferred": return e.from && e.from !== e.ref ? { before: "Received ", after: ` from ${e.from}` } : { before: "Transferred ", after: "" };
    default: return { before: "", after: "" };
  }
}

/** The same as one line of text. */
export function activityText(e: ActivityEvent): string {
  const { before, after } = activityParts(e);
  return `${before}${e.ref}${after}`;
}

/** Every public URL that is the same publisher: host accounts, website and social links (schema.org sameAs). */
export function sameAs(n: Namespace): string[] {
  const p = n.profile;
  if (!p) return [];
  return [...new Set([...p.hosts.map((h) => h.url), ...(p.website ? [p.website] : []), ...p.socials.map((s) => s.url)])];
}

/** The publisher as a schema.org Person (a user) or Organization (an org or group), with only what the page shows. */
export function publisherEntity(n: Namespace): Record<string, unknown> {
  const p = n.profile;
  const person = n.kind === "user";
  const name = n.display_name ?? n.name;
  const links = sameAs(n);
  const entity: Record<string, unknown> = {
    "@type": person ? "Person" : "Organization",
    "@id": `${SITE_URL}/${n.name}#publisher`,
    name,
    alternateName: n.name,
    url: `${SITE_URL}/${n.name}`,
    ...(n.avatar_url ? { image: n.avatar_url } : {}),
    ...(p?.bio ? { description: p.bio } : {}),
    ...(links.length ? { sameAs: links } : {}),
  };
  if (p?.location) entity[person ? "homeLocation" : "location"] = { "@type": "Place", name: p.location };
  if (person && p?.company) entity.worksFor = { "@type": "Organization", name: p.company.replace(/^@/, "") };
  if (!person && p?.members.length) entity.member = p.members.map((m) => ({ "@type": "Person", name: m.login, url: m.url }));
  return entity;
}

/** The ProfilePage node for Base's JSON-LD graph. */
export function profilePage(n: Namespace): Record<string, unknown> {
  return {
    "@type": "ProfilePage",
    "@id": `${SITE_URL}/${n.name}`,
    url: `${SITE_URL}/${n.name}`,
    name: `${n.display_name ?? n.name} on OTInstaller`,
    dateCreated: new Date(n.created_at).toISOString(),
    mainEntity: publisherEntity(n),
  };
}

/** Text someone else wrote, made safe for Markdown: no tag can become raw HTML in the reader's renderer. */
const plain = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const pkgUrl = (t: Pkg) => (t.kind === "guide" ? `${SITE_URL}/guides/${t.namespace}/${t.name}.md` : `${SITE_URL}/${t.namespace}/${t.name}.md`);

/** /<ns>.md: the profile as Markdown for agents, with links to each package's own Markdown page. */
export function profileMarkdown(n: Namespace, activity: ActivityEvent[] = []): string {
  const p = n.profile;
  const s = n.stats;
  const name = n.display_name ?? n.name;
  const out: string[] = [`# ${name}${name !== n.name ? ` (${n.name})` : ""}`, ""];
  if (n.status === "pending_review") {
    out.push(`${n.name} is a new publisher on the OTInstaller Registry. Its first release is waiting for review, so nothing is published yet.`, "");
  }
  if (p?.bio) out.push(plain(p.bio), "");
  const facts: string[] = [`- Kind: ${kindLabel(n.kind, n.provider)}${n.verified ? " (verified publisher)" : ""}`];
  for (const h of p?.hosts ?? []) facts.push(`- On ${hostName(h.provider)}: [${h.login}](${h.url})`);
  if (p?.location) facts.push(`- Location: ${p.location}`);
  if (p?.company) facts.push(`- Company: ${p.company}`);
  if (p?.website) facts.push(`- Website: ${p.website}`);
  for (const so of p?.socials ?? []) facts.push(`- ${socialLabel(so)}: ${so.url}`);
  facts.push(`- On OTInstaller since: ${formatDate(n.created_at)}`);
  facts.push(`- Profile: ${SITE_URL}/${n.name}`);
  out.push(...facts, "");
  if (s && s.packages) {
    out.push("## Stats", "");
    out.push(`- Packages: ${s.packages} (${s.tools} ${s.tools === 1 ? "tool" : "tools"}, ${s.guides} ${s.guides === 1 ? "guide" : "guides"})`);
    out.push(`- Installs: ${formatCount(s.installs_30d)} in the last 30 days, ${formatCount(s.installs_total)} in all`);
    if (s.tools) out.push(`- Nightly health check: ${s.healthy} passing, ${s.broken} possibly broken`);
    if (s.last_published_at) out.push(`- Last published: ${formatDate(s.last_published_at)}`);
    out.push("");
  }
  if (p?.about_html) {
    // One paragraph per block of the rendered About, so headings and paragraphs don't run together.
    const blocks = p.about_html.split(/<\/(?:p|h[1-6]|li|blockquote|pre|div)>|<br\s*\/?>/i).map((b) => plain(textOf(b))).filter(Boolean);
    out.push("## About", "", blocks.join("\n\n"), "");
  }
  const byName = new Map(n.tools.map((t) => [t.name, t]));
  const pinned = (p?.pins ?? []).map((x) => byName.get(x)).filter((t): t is Pkg => !!t);
  if (pinned.length) out.push("## Pinned", "", ...pinned.map((t) => `- [${t.namespace}/${t.name}](${pkgUrl(t)}): ${t.summary}`), "");
  const tools = n.tools.filter((t) => t.kind === "tool");
  const guides = n.tools.filter((t) => t.kind === "guide");
  if (tools.length) out.push("## Tools", "", ...tools.map((t) => `- [${t.namespace}/${t.name}](${pkgUrl(t)}): ${sentence(t.summary)} Install with \`ot install ${t.namespace}/${t.name}\`.`), "");
  if (guides.length) out.push("## Guides", "", ...guides.map((t) => `- [${t.title ?? `${t.namespace}/${t.name}`}](${pkgUrl(t)}): ${t.summary}`), "");
  if (!tools.length && !guides.length && n.status !== "pending_review") out.push(`${name} has not published anything yet.`, "");
  if (activity.length) out.push("## Recent activity", "", ...activity.slice(0, 10).map((e) => `- ${formatDate(e.at)}: ${activityText(e)}`), "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** The About HTML with its headings moved down so the top one is an h3, under the profile's "About" h2. */
export function aboutHtml(html: string): string {
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  if (!levels.length) return html;
  const shift = 3 - Math.min(...levels);
  if (shift <= 0) return html;
  return html.replace(/<(\/?)h([1-6])\b/gi, (_, slash: string, n: string) => `<${slash}h${Math.min(6, Number(n) + shift)}`);
}
