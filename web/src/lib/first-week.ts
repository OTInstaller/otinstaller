// Words for a new version's first week: what people said about it since it came out, on the tool page, the versions
// list and "What's new". The counts come from the API (first_week, new_version); this only words them.
import type { FirstWeek } from "./api";

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** "works for 3 people, broken for 1 person", or that nobody has said yet. */
export function firstWeekSaid(c: Pick<FirstWeek, "works" | "broken">): string {
  const said = [c.works ? `works for ${people(c.works)}` : null, c.broken ? `broken for ${people(c.broken)}` : null].filter(Boolean).join(", ");
  return said || "nobody has said yet whether it works";
}

/** The counts in a few words, for a badge: "2 works, 1 broken", or "no reports yet". */
export function firstWeekCounts(c: Pick<FirstWeek, "works" | "broken">): string {
  return [c.works ? `${c.works} works` : null, c.broken ? `${c.broken} broken` : null].filter(Boolean).join(", ") || "no reports yet";
}

/** A status tone for the counts, as the status line judges them: more broken than works (two or more) is bad. */
export function firstWeekTone(c: Pick<FirstWeek, "works" | "broken">): "ok" | "warn" | "bad" | "none" {
  if (c.broken >= 2 && c.broken > c.works) return "bad";
  if (c.broken > 0) return "warn";
  return c.works > 0 ? "ok" : "none";
}

/** Platforms people reported on, most reports first: "linux/amd64 (3 works, 1 broken)". */
export function firstWeekPlatforms(platforms: Record<string, { works: number; broken: number }>): string[] {
  return Object.entries(platforms)
    .filter(([p]) => p !== "unknown")
    .sort((a, b) => b[1].works + b[1].broken - (a[1].works + a[1].broken))
    .map(([p, c]) => `${p} (${firstWeekCounts(c)})`);
}
