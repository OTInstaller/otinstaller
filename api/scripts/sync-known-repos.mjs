// Writes src/known-repos.ts from otlite's catalog and seed/candidates.md (see known-repos-lib.mjs). Run with
// `npm run sync:known-repos` after either changes; a test fails when the copy drifts.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildKnownRepos } from "./known-repos-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { otlite, dropped, reasons } = buildKnownRepos(root);
const lines = (o) => Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
writeFileSync(
  path.join(root, "api/src/known-repos.ts"),
  `// Generated from otlite/src/otlite/data/registry.yaml and seed/candidates.md by scripts/sync-known-repos.mjs. Do not edit.\n` +
    `/** Repositories otlite installs, keyed "github:owner/repo" (lowercase), with otlite's name for each. */\n` +
    `export const OTLITE_REPOS: Record<string, string> = {\n${lines(otlite)}\n};\n\n` +
    `/** Why the seed survey dropped a repository, as indexes into DROPPED_REASONS. */\n` +
    `export const DROPPED_REPOS: Record<string, number> = {\n${lines(dropped)}\n};\n\n` +
    `export const DROPPED_REASONS: string[] = ${JSON.stringify(reasons, null, 2)};\n`,
);
