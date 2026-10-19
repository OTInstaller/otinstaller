// Writes .wrangler/seed.sql for `npm run db:seed` (local D1 only).
import { mkdirSync, writeFileSync } from "node:fs";
import { buildSeedStatements } from "./seed-lib.mjs";

const reset = [
  "aliases", "tool_guides", "tool_secrets", "sources", "tool_io", "install_counts", "versions", "tools", "namespaces",
].map((t) => `DELETE FROM ${t};`);
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/seed.sql", [...reset, ...buildSeedStatements()].join("\n") + "\n");
console.log("Wrote .wrangler/seed.sql");
