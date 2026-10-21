// Helpers for server-rendered pages.
import type { AstroGlobal } from "astro";
import { api, type SearchResult } from "./api";

/** The Cache-Control value for a public response kept `seconds` at the edge (browsers keep it a minute at most). */
export function cacheControl(seconds: number): string {
  return `public, max-age=${Math.min(seconds, 60)}, s-maxage=${seconds}`;
}

/** Edge-caches a page the way the plan says (e.g. 60 s for tool pages, 5 min for the home page). */
export function cacheFor(Astro: AstroGlobal, seconds: number) {
  Astro.response.headers.set("Cache-Control", cacheControl(seconds));
}

/** Reads search filters from the query string and asks the API. */
export async function searchFrom(url: URL, extra: Record<string, string> = {}, path = "/tools"): Promise<{ params: URLSearchParams; result: SearchResult }> {
  const params = new URLSearchParams();
  for (const key of ["q", "input", "output", "category", "runtime", "sort", "cursor", "level", "format", "lang"]) {
    const v = url.searchParams.get(key);
    if (v) params.set(key, v);
  }
  if (url.searchParams.get("no_keys")) params.set("no_keys", "1");
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  if (!params.has("limit")) params.set("limit", "24");
  const result = await api<SearchResult>(`${path}?${params}`);
  return { params, result };
}

/** A link to the same page with one query parameter changed (null removes it). */
export function withParam(url: URL, key: string, value: string | null): string {
  const u = new URL(url);
  if (value === null) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  u.searchParams.delete("cursor");
  return `${u.pathname}${u.search}`;
}
