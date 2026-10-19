import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_SEED: string[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tools").first<{ n: number }>();
if (!count?.n) await env.DB.batch(env.TEST_SEED.map((s: string) => env.DB.prepare(s)));
