// Builds the list of repositories the registry already knows about outside its own tables: the tools otlite
// installs (otlite/src/otlite/data/registry.yaml) and the ones the October 2026 seed survey dropped, with why
// (seed/candidates.md). Tool requests show these to the requester and to triagers. Used by sync-known-repos.mjs
// and by vitest.config.ts, which checks src/known-repos.ts against it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

// Of the automatic filters, only those a live check doesn't repeat (the license and archived checks do).
const KEPT_FILTERS = [
  [/^Abandoned/, "no commits for two years when the seed was surveyed (October 2026)"],
  [/^A fork/, "a fork; package the original project instead"],
];

/** @returns {{ otlite: Record<string, string>, dropped: Record<string, number>, reasons: string[] }} */
export function buildKnownRepos(root) {
  const otlite = {};
  const registry = parse(readFileSync(path.join(root, "otlite/src/otlite/data/registry.yaml"), "utf8"));
  for (const t of registry.tools ?? []) {
    if (typeof t.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo)) otlite[`github:${t.repo.toLowerCase()}`] = t.name;
  }
  const reasons = [];
  const dropped = {};
  const reasonId = (r) => {
    let i = reasons.indexOf(r);
    if (i < 0) i = reasons.push(r) - 1;
    return i;
  };
  const md = readFileSync(path.join(root, "seed/candidates.md"), "utf8");
  for (const line of md.split("\n")) {
    const row = /^\| \[([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\]\(https:\/\/github\.com\/[^)]+\) \| [^|]* \| [^|]* \| dropped \| (.+?) \|$/.exec(line);
    if (row) {
      dropped[`github:${row[1].toLowerCase()}`] = reasonId(row[2].trim());
      continue;
    }
    const filter = /^\*\*(.+?)\*\* \(\d+\): (.+)$/.exec(line);
    const kept = filter && KEPT_FILTERS.find(([re]) => re.test(filter[1]));
    if (kept) {
      const id = reasonId(kept[1]);
      for (const repo of filter[2].replace(/\.$/, "").split(/,\s*/)) {
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) dropped[`github:${repo.toLowerCase()}`] ??= id;
      }
    }
  }
  // What otlite installs was not dropped from the registry for good; otlite is the better answer.
  for (const k of Object.keys(otlite)) delete dropped[k];
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { otlite: sorted(otlite), dropped: sorted(dropped), reasons };
}
