import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
// @ts-expect-error plain JS module
import { buildSeedStatements } from "./scripts/seed-lib.mjs";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // The spec's example manifests, so the API's validator is held to the same expectations as the CLI's.
  const fixtures = ["valid", "invalid"].flatMap((dir) =>
    readdirSync(`../spec/fixtures/${dir}`)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => ({ dir, name: f, text: readFileSync(`../spec/fixtures/${dir}/${f}`, "utf8") })),
  );
  // The release workflows the import wizard commits, to check the API's generated copy against.
  const templates = Object.fromEntries(
    readdirSync("../spec/templates")
      .filter((f) => f.endsWith(".yml"))
      .map((f) => [f.replace(/\.yml$/, ""), readFileSync(`../spec/templates/${f}`, "utf8")]),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_SEED: buildSeedStatements(),
          TEST_FIXTURES: fixtures,
          TEST_TEMPLATES: templates,
          SITE_URL: "https://otinstaller.com",
          API_URL: "https://api.otinstaller.com",
          GITHUB_APP_ID: "123",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          GITHUB_CLIENT_ID: "gh-client",
          GITHUB_CLIENT_SECRET: "gh-secret",
          GITLAB_CLIENT_ID: "gl-client",
          GITLAB_CLIENT_SECRET: "gl-secret",
          TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          OPS_REPO: "osintverse/registry-ops",
          OPS_INSTALLATION_ID: "999",
          RESEND_API_KEY: "re_test",
        } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
