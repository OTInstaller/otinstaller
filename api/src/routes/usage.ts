// Usage counts from ot: POST /installs after each install and POST /runs with a command's runs, anonymous and without
// a token, plus the staff Usage report. What is counted and how is in src/usage.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { ulid } from "../lib/crypto";
import { reportError } from "../ops";
import { installInput, LIMITS, recordInstall, recordRuns, runsInput, usageReport } from "../usage";
import { requireReviewer } from "./review";

/** Counts come from programs such as ot, which send no Origin; every browser does, so no web page can add to them. */
function programOnly(c: Context<AppEnv>) {
  if (c.req.header("origin")) {
    apiError(403, "foreign_origin", "usage counts are taken only from programs such as ot", "nothing to do: ot sends them on its own");
  }
}

export function usageRoutes(app: App) {
  // Old and new ot. Answered after counting, as before 0044.
  app.post("/installs", async (c) => {
    programOnly(c);
    const input = installInput(await c.req.json().catch(() => ({})));
    await recordInstall(c.env, c.req.header("cf-connecting-ip") ?? null, input);
    return c.body(null, 204);
  });

  // Answered as soon as the body checks out; the counting finishes after the answer, so ot never waits on it.
  app.post("/runs", async (c) => {
    programOnly(c);
    if (Number(c.req.header("content-length") ?? 0) > LIMITS.body) apiError(400, "invalid_body", `send at most ${LIMITS.runs} runs at a time`);
    const text = await c.req.text();
    if (text.length > LIMITS.body) apiError(400, "invalid_body", `send at most ${LIMITS.runs} runs at a time`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      apiError(400, "invalid_body", "send JSON: {client, runs: [{tool, version, outcome, duration_ms}]}");
    }
    const input = runsInput(body);
    const address = c.req.header("cf-connecting-ip") ?? null;
    c.executionCtx.waitUntil(recordRuns(c.env, address, input).catch((e) =>
      reportError(c.env, e, { requestId: c.req.header("cf-ray") ?? ulid(), method: "POST", path: "/v1/runs", fingerprint: ["usage", "runs"] })));
    return c.body(null, 204);
  });

  // ---------- staff ----------

  app.get("/admin/usage", async (c) => {
    requireReviewer(c);
    const days = Number(c.req.query("days") ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 90) apiError(400, "invalid_parameter", "days must be a whole number from 1 to 90");
    const tool = c.req.query("tool") ?? null;
    if (tool !== null && !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(tool)) apiError(400, "invalid_parameter", "tool must be namespace/name");
    c.header("Cache-Control", "private, no-store");
    return c.json(await usageReport(c.env, days, tool));
  });
}
