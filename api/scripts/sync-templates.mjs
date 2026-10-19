// Copies spec/templates (the release workflows `ot init` writes) into src/release-templates.ts, so the import
// wizard opens pull and merge requests with the same files. Run with `npm run sync:templates`; a test fails
// when the copies drift.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "spec/templates");
const entries = readdirSync(dir).filter((f) => f.endsWith(".yml")).sort()
  .map((f) => `  ${JSON.stringify(f.replace(/\.yml$/, ""))}: ${JSON.stringify(readFileSync(path.join(dir, f), "utf8"))},`);
writeFileSync(
  path.join(root, "api/src/release-templates.ts"),
  `// Generated from spec/templates by scripts/sync-templates.mjs. Do not edit.\nexport const RELEASE_TEMPLATES: Record<string, string> = {\n${entries.join("\n")}\n};\n`,
);
