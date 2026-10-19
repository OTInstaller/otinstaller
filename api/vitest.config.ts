import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
// @ts-expect-error plain JS module
import { buildSeedStatements } from "./scripts/seed-lib.mjs";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_SEED: buildSeedStatements() } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
