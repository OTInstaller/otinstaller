import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_SEED: string[];
      TEST_FIXTURES: { dir: string; name: string; text: string }[];
      GITHUB_APP_ID: string;
      GITHUB_WEBHOOK_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      GITLAB_CLIENT_ID: string;
      GITLAB_CLIENT_SECRET: string;
      TOKEN_ENC_KEY: string;
      OPS_REPO: string;
      OPS_INSTALLATION_ID: string;
      RESEND_API_KEY: string;
      SITE_URL: string;
      API_URL: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tools").first<{ n: number }>();
if (!count?.n) await env.DB.batch(env.TEST_SEED.map((s: string) => env.DB.prepare(s)));
