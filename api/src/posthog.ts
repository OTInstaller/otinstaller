// Forwarding usage counts to PostHog, where staff can break them down: each install and run the registry counted
// (usage.ts) becomes one event, sent after the answer from the same waitUntil. Only the fields usage.ts keeps go out,
// with the country Cloudflare saw. No address is sent: the distinct ID is an HMAC of the address with a random salt
// that is replaced every UTC day (settings.usage_salt), so one day's events can't be tied to another day's, and no
// person profiles are made. Off unless POSTHOG_PROJECT_TOKEN and POSTHOG_HOST are both set.
import { deps, type Env } from "./env";
import { hmacSha256Hex, toHex } from "./lib/crypto";
import { reportError } from "./ops";
import type { Counted } from "./usage";

/** What the request said about the client, sent with each of its events. */
export type Sender = { client: string; os: string; arch: string; ot_version: string; mcp_client?: string | null; engine?: string };

let cachedSalt: { day: string; salt: string } | null = null;

/** Today's salt, made on the first request of each UTC day; whichever isolate writes first wins, and the rest read it. */
export async function dailySalt(env: Env, now = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (cachedSalt?.day === day) return cachedSalt.salt;
  const fresh = `${day}:${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('usage_salt', ?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE substr(settings.value, 1, 10) != ?3`,
  ).bind(fresh, now, day).run();
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'usage_salt'`).first<{ value: string }>();
  const value = row?.value ?? fresh;
  cachedSalt = { day, salt: value.slice(11) };
  return cachedSalt.salt;
}

/** The events for what one request counted, as PostHog's /batch/ takes them. */
export async function usageEvents(env: Env, counted: Counted, sender: Sender, address: string | null, country: string | null, now = Date.now()) {
  const distinctId = address ? `d_${(await hmacSha256Hex(await dailySalt(env, now), address)).slice(0, 32)}` : "d_unknown";
  const common = {
    client: sender.client, os: sender.os, arch: sender.arch, ot_version: sender.ot_version,
    $process_person_profile: false, $geoip_disable: true, $lib: "otinstaller-api",
    ...(country ? { $geoip_country_code: country } : {}),
  };
  const timestamp = new Date(now).toISOString();
  const event = (name: string, properties: Record<string, unknown>) => ({ event: name, distinct_id: distinctId, timestamp, properties: { ...common, ...properties } });
  return [
    ...counted.installs.map((i) => event("ot_install", {
      tool: i.tool, tool_version: i.version, tool_runtime: i.runtime, from_backup: i.from_backup, first: i.first, engine: sender.engine ?? "other",
    })),
    ...counted.runs.map((r) => event("ot_run", {
      tool: r.tool, tool_version: r.version, tool_runtime: r.runtime, outcome: r.outcome, duration_ms: r.duration_ms, engine: r.engine, via: r.via,
      ...(sender.mcp_client ? { mcp_client: sender.mcp_client } : {}),
    })),
    ...counted.failures.map((f) => event("ot_install_failed", { tool: f.tool, tool_version: f.version, tool_runtime: f.runtime, reason: f.reason })),
    ...counted.milestones.map((m) => event("ot_activation", { milestone: m })),
  ];
}

/** Sends what one request counted. Never throws: a PostHog outage is reported as a warning and the counts in D1 stand. */
export async function forwardUsage(env: Env, counted: Counted, sender: Sender, address: string | null, country: string | null, now = Date.now()) {
  if (!env.POSTHOG_PROJECT_TOKEN || !env.POSTHOG_HOST) return;
  try {
    const batch = await usageEvents(env, counted, sender, address, country, now);
    if (!batch.length) return;
    const res = await deps.fetch(`${env.POSTHOG_HOST.replace(/\/+$/, "")}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_TOKEN, batch }),
    });
    if (!res.ok) throw new Error(`PostHog answered ${res.status}`);
  } catch (e) {
    await reportError(env, e, { requestId: `posthog-${now}`, level: "warning", fingerprint: ["posthog-forward"] });
  }
}

/** The country Cloudflare placed the request in, without its codes for unknown (XX) and Tor (T1). */
export function requestCountry(req: Request): string | null {
  const country = (req as Request & { cf?: { country?: string } }).cf?.country;
  return country && country !== "XX" && country !== "T1" ? country : null;
}
