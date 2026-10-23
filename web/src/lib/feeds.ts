// Atom and JSON Feed for what changes in the registry: the whole registry, a publisher, a tool's releases and the
// tools for one input type. Built from the API's activity and versions; the routes are the feed.atom.ts and
// feed.json.ts files next to the pages they follow, and /new lists the same events as a page.
import { api, ApiError, SITE_URL, type RegistryActivity, type RegistryEvent, type ToolDetail, type Version } from "./api";
import { cacheControl } from "./page";

export interface FeedEntry {
  id: string;
  title: string;
  url: string;
  /** Unix milliseconds. */
  updated: number;
  /** Plain text. */
  summary?: string;
  /** Sanitized HTML (release notes rendered by the registry). */
  html?: string;
}

export interface Feed {
  title: string;
  description: string;
  /** The page the feed follows. */
  home: string;
  /** The feed's own path without its extension, e.g. "/feed" or "/dheeraj/feed". */
  path: string;
  entries: FeedEntry[];
}

export type FeedFormat = "atom" | "json";

/** The feeds a page offers, as rel="alternate" links: its own (if any) after the registry-wide one. */
export function feedLinks(own?: { title: string; path: string }): { title: string; href: string; type: string }[] {
  const feeds = [{ title: "OTInstaller: what's new", path: "/feed" }, ...(own ? [own] : [])];
  return feeds.flatMap((f) => [
    { title: f.title, href: `${f.path}.atom`, type: "application/atom+xml" },
    { title: f.title, href: `${f.path}.json`, type: "application/feed+json" },
  ]);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const iso = (ms: number) => new Date(ms).toISOString();
const abs = (path: string) => (/^https?:/.test(path) ? path : `${SITE_URL}${path}`);

/** Where a package's page is: guides live under /guides. */
export const packageHref = (kind: string, ref: string) => (kind === "guide" ? `/guides/${ref}` : `/${ref}`);

/** One registry event as a feed entry. Titles are built from fields, never from text a publisher wrote. */
export function eventEntry(e: RegistryEvent): FeedEntry {
  const what = e.kind === "guide" ? "guide" : "tool";
  const v = e.version ? ` ${e.version}` : "";
  const page = packageHref(e.kind, e.ref);
  const title = {
    published: e.new_package ? `New ${what}: ${e.ref}` : `${e.ref}${v} released`,
    yanked: `${e.ref}${v} yanked`,
    unyanked: `${e.ref}${v} restored`,
    deprecated: `${e.ref} deprecated${e.replacement ? `: use ${e.replacement}` : ""}`,
    undeprecated: `${e.ref} no longer deprecated`,
    transferred: `${e.ref} moved${e.to ? ` to ${e.to}` : ""}`,
  }[e.type] ?? `${e.ref} ${e.type}`;
  const url = e.type === "published" && e.has_notes && e.kind === "tool" ? `${page}/versions#v${e.version}` : page;
  return { id: `tag:otinstaller.com,2026:${e.id}`, title, url, updated: e.at, summary: e.summary };
}

/** A tool's published versions as entries, with their release notes as content. */
export function versionEntries(t: Pick<ToolDetail, "namespace" | "name" | "summary">, versions: Version[]): FeedEntry[] {
  const ref = `${t.namespace}/${t.name}`;
  return versions
    .filter((v) => v.status !== "removed" && v.published_at)
    .map((v) => ({
      id: `tag:otinstaller.com,2026:${ref}@${v.version}`,
      title: `${ref} ${v.version}${v.status === "yanked" ? " (yanked)" : ""}`,
      url: `/${ref}/versions#v${v.version}`,
      updated: v.published_at!,
      summary: v.changelog_html ? undefined : t.summary,
      html: v.changelog_html ?? undefined,
    }));
}

/** The feed as Atom 1.0. */
export function atom(f: Feed): string {
  const updated = f.entries.reduce((m, e) => Math.max(m, e.updated), 0) || Date.UTC(2026, 0, 1);
  const entries = f.entries.map((e) => [
    "  <entry>",
    `    <id>${xml(e.id)}</id>`,
    `    <title>${xml(e.title)}</title>`,
    `    <link rel="alternate" type="text/html" href="${xml(abs(e.url))}"/>`,
    `    <updated>${iso(e.updated)}</updated>`,
    e.summary ? `    <summary>${xml(e.summary)}</summary>` : null,
    e.html ? `    <content type="html">${xml(e.html)}</content>` : null,
    "  </entry>",
  ].filter(Boolean).join("\n"));
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom">`,
    `  <id>${xml(abs(f.path))}</id>`,
    `  <title>${xml(f.title)}</title>`,
    `  <subtitle>${xml(f.description)}</subtitle>`,
    `  <link rel="self" type="application/atom+xml" href="${xml(abs(`${f.path}.atom`))}"/>`,
    `  <link rel="alternate" type="text/html" href="${xml(abs(f.home))}"/>`,
    `  <updated>${iso(updated)}</updated>`,
    `  <author><name>OTInstaller</name><uri>${SITE_URL}</uri></author>`,
    ...entries,
    `</feed>`,
    "",
  ].join("\n");
}

/** The feed as JSON Feed 1.1. */
export function jsonFeed(f: Feed): Record<string, unknown> {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: f.title,
    description: f.description,
    home_page_url: abs(f.home),
    feed_url: abs(`${f.path}.json`),
    authors: [{ name: "OTInstaller", url: SITE_URL }],
    items: f.entries.map((e) => ({
      id: e.id,
      url: abs(e.url),
      title: e.title,
      date_published: iso(e.updated),
      ...(e.html ? { content_html: e.html } : { content_text: e.summary ?? e.title }),
      ...(e.html && e.summary ? { summary: e.summary } : {}),
    })),
  };
}

/** A feed response: cached 10 minutes at the edge and kept out of search results. */
export function feedResponse(f: Feed, format: FeedFormat): Response {
  const headers = { "Cache-Control": cacheControl(600), "X-Robots-Tag": "noindex", "Access-Control-Allow-Origin": "*" };
  return format === "atom"
    ? new Response(atom(f), { headers: { ...headers, "Content-Type": "application/atom+xml; charset=utf-8" } })
    : new Response(JSON.stringify(jsonFeed(f), null, 2), { headers: { ...headers, "Content-Type": "application/feed+json; charset=utf-8" } });
}

/** A 404 for a feed of something that does not exist (or that the API cannot serve right now: 503). */
export function feedMissing(status = 404): Response {
  return new Response(status === 404 ? "No such feed\n" : "The registry is not answering; try again shortly\n", {
    status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

/** Answers with a feed, or a plain 404 (unknown package or namespace) or 503 (the API is down). */
export async function serveFeed(load: () => Promise<Feed>, format: FeedFormat): Promise<Response> {
  try {
    return feedResponse(await load(), format);
  } catch (e) {
    return feedMissing(e instanceof ApiError && [400, 404, 410].includes(e.status) ? 404 : 503);
  }
}

/** The registry-wide feed: the newest 50 events. */
export async function registryFeed(): Promise<Feed> {
  const { events } = await api<RegistryActivity>("/activity?limit=50");
  return { title: "OTInstaller: what's new", description: "New tools and guides, releases, yanks and deprecations in the OTInstaller registry.", home: "/new", path: "/feed", entries: events.map(eventEntry) };
}

/** One publisher's packages (a namespace that does not exist answers 404). */
export async function publisherFeed(ns: string): Promise<Feed> {
  const [profile, { events }] = await Promise.all([
    api<{ name: string; display_name?: string }>(`/namespaces/${encodeURIComponent(ns)}`),
    api<RegistryActivity>(`/activity?namespace=${encodeURIComponent(ns)}&limit=50`),
  ]);
  const who = profile.display_name || profile.name;
  return { title: `${who} on OTInstaller`, description: `Releases, yanks and deprecations of ${who}'s packages.`, home: `/${ns}`, path: `/${ns}/feed`, entries: events.map(eventEntry) };
}

/** One tool's releases, with their notes. */
export async function toolFeed(ns: string, name: string): Promise<Feed> {
  const ref = `${ns}/${name}`;
  const [tool, { versions }] = await Promise.all([api<ToolDetail>(`/tools/${ref}`), api<{ versions: Version[] }>(`/tools/${ref}/versions`)]);
  return { title: `${ref} releases`, description: tool.summary, home: `/${ref}/versions`, path: `/${ref}/feed`, entries: versionEntries(tool, versions).slice(0, 50) };
}

/** Tools and guides for one input type. */
export async function inputFeed(type: string, label: string): Promise<Feed> {
  const { events } = await api<RegistryActivity>(`/activity?input=${encodeURIComponent(type)}&limit=30`);
  return { title: `OTInstaller: ${label} tools`, description: `New tools and releases for investigating ${label} values.`, home: `/input/${type}`, path: `/input/${type}/feed`, entries: events.map(eventEntry) };
}
