// Internal endpoints for the nightly health workflow in registry-ops, authorized with HEALTH_TOKEN.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { applyHealth, healthTargets, type HealthResult } from "../ops";

async function requireHealthToken(c: Context<AppEnv>) {
  const expected = c.env.HEALTH_TOKEN;
  if (!expected) apiError(503, "not_configured", "HEALTH_TOKEN is not configured on this server");
  const header = c.req.header("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Compare digests so the comparison does not leak the token through timing.
  if (!given || (await sha256Hex(given)) !== (await sha256Hex(expected))) apiError(401, "unauthenticated", "missing or wrong health token");
}

export function opsRoutes(app: App) {
  app.get("/internal/health/targets", async (c) => {
    await requireHealthToken(c);
    return c.json({ targets: await healthTargets(c.env) });
  });

  app.post("/internal/health", async (c) => {
    await requireHealthToken(c);
    const body = await c.req.json<{ results?: HealthResult[] }>().catch(() => null);
    if (!body || !Array.isArray(body.results) || body.results.length > 500) apiError(400, "invalid_body", "send {results: [{version_id, result: 'pass' | 'fail', duration_ms, error_excerpt}]}, at most 500");
    return c.json({ applied: await applyHealth(c.env, body.results) });
  });
}
