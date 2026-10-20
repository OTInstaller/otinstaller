// `ot login --osintverse`: the registry's own device flow on top of the OSINTverse web sign-in.
//
// OSINTverse gives the registry one confidential client, so the CLI cannot run OSINTverse's device
// flow itself. Instead the CLI gets a code from the API (start), the user opens /v1/auth/osintverse/device
// and types it, signs in on osintverse.com, then approves the CLI on a confirmation page. The CLI's next
// poll receives an ot_ token. Typing the code and the separate approval step keep someone else's code,
// sent in a link, from signing a stranger's CLI in as you.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { randomToken, sha256Hex, ulid } from "../lib/crypto";
import { audit, mintApiToken, osintverseLogin } from "./auth";

const TTL = 10 * 60 * 1000;
const INTERVAL = 5; // seconds between polls
// No vowels (no accidental words) and nothing that looks like another character.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

interface DeviceRow {
  id: string;
  status: "pending" | "authorized" | "approved" | "denied" | "consumed";
  user_code: string;
  user_id: string | null;
  confirm_token_hash: string | null;
  client_info: string | null;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
}

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** "bcdf ghjk", "BCDFGHJK" and "BCDF-GHJK" are the same code. */
export function normalizeCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** A minimal page, served by the API: no scripts, nothing loaded from elsewhere. */
export function devicePage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · OTInstaller</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input{background:#222;color:#eee}}
h1{font-size:1.4rem}input{font:inherit;font-size:1.4rem;letter-spacing:.15em;text-transform:uppercase;padding:.4rem .6rem;width:12rem}
button{font:inherit;padding:.5rem 1rem;margin:.5rem .5rem 0 0;cursor:pointer}code{font-size:1.1em}.muted{opacity:.7;font-size:.9rem}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

function codeForm(message = ""): string {
  return devicePage("Sign in to ot with OSINTverse", `${message}
<p>Enter the code that <code>ot login --osintverse</code> shows in your terminal.</p>
<form method="post" action="/v1/auth/osintverse/device">
<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" required autofocus>
<button type="submit">Continue</button></form>
<p class="muted">Only enter a code you started on your own computer. Nobody from OTInstaller will ever ask you for one.</p>`);
}

/** POST /auth/device/start with provider "osintverse". */
export async function startOsintverseDevice(c: Context<AppEnv>) {
  const now = Date.now();
  const deviceCode = randomToken(32);
  const code = userCode();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM device_logins WHERE expires_at < ?`).bind(now - 24 * 3600 * 1000),
    c.env.DB.prepare(
      `INSERT INTO device_logins (id, provider, device_code_hash, user_code, client_info, created_at, expires_at) VALUES (?, 'osintverse', ?, ?, ?, ?, ?)`,
    ).bind(ulid(now), await sha256Hex(deviceCode), code, c.req.header("user-agent")?.slice(0, 120) ?? null, now, now + TTL),
  ]);
  return {
    provider: "osintverse", device_code: deviceCode, user_code: code,
    verification_uri: `${c.env.API_URL}/v1/auth/osintverse/device`, interval: INTERVAL, expires_in: TTL / 1000,
  };
}

/** POST /auth/device/token with provider "osintverse": pending, slow_down, expired, denied or ok with a token. */
export async function pollOsintverseDevice(c: Context<AppEnv>, deviceCode: string, tokenName?: string) {
  const db = c.env.DB;
  const now = Date.now();
  const row = await db.prepare(`SELECT * FROM device_logins WHERE device_code_hash = ? AND provider = 'osintverse'`).bind(await sha256Hex(deviceCode)).first<DeviceRow>();
  if (!row || row.status === "consumed") return { status: "expired" };
  if (row.status === "denied") return { status: "denied" };
  if (row.expires_at < now) return { status: "expired" };
  if (row.status !== "approved") {
    const tooSoon = row.last_polled_at !== null && now - row.last_polled_at < (INTERVAL - 1) * 1000;
    await db.prepare(`UPDATE device_logins SET last_polled_at = ? WHERE id = ?`).bind(now, row.id).run();
    return { status: tooSoon ? "slow_down" : "pending" };
  }
  // Exactly one poll gets the token, even if two arrive at once.
  const taken = await db.prepare(`UPDATE device_logins SET status = 'consumed' WHERE id = ? AND status = 'approved'`).bind(row.id).run();
  if (!taken.meta.changes) return { status: "expired" };
  const user = await db.prepare(`SELECT login FROM users WHERE id = ? AND banned_at IS NULL`).bind(row.user_id).first<{ login: string }>();
  if (!user) return { status: "denied" };
  const { token } = await mintApiToken(db, row.user_id!, (tokenName ?? "ot CLI").slice(0, 60));
  await audit(db, row.user_id, "user", "token.create", "device_login", row.id, { provider: "osintverse" }).run();
  return { status: "ok", token, login: user.login, provider: "osintverse" };
}

/** After the OSINTverse sign-in for a device login: ask the user to approve the CLI. */
export async function authorizeDevice(c: Context<AppEnv>, deviceId: string, userId: string) {
  const db = c.env.DB;
  const confirm = randomToken(24);
  const r = await db.prepare(
    `UPDATE device_logins SET status = 'authorized', user_id = ?, confirm_token_hash = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(userId, await sha256Hex(confirm), deviceId, Date.now()).run();
  if (!r.meta.changes) return c.html(devicePage("This code has expired", "<p>Run <code>ot login --osintverse</code> again for a new code.</p>"), 410);
  const row = (await db.prepare(`SELECT * FROM device_logins WHERE id = ?`).bind(deviceId).first<DeviceRow>())!;
  const user = (await db.prepare(`SELECT login FROM users WHERE id = ?`).bind(userId).first<{ login: string }>())!;
  const started = new Date(row.created_at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return c.html(devicePage("Approve ot on this computer?", `
<p>You're signed in as <strong>${esc(user.login)}</strong>. Approving gives the <code>ot</code> command line tool a token for
your OTInstaller account.</p>
<p>Code <code>${esc(row.user_code)}</code>, started ${esc(started)}${row.client_info ? ` by <span class="muted">${esc(row.client_info)}</span>` : ""}.
It should match the code in your terminal.</p>
<form method="post" action="/v1/auth/osintverse/device/confirm">
<input type="hidden" name="id" value="${esc(row.id)}"><input type="hidden" name="confirm" value="${esc(confirm)}">
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button>
</form>`));
}

export function deviceRoutes(app: App) {
  app.get("/auth/osintverse/device", (c) => c.html(codeForm()));

  app.post("/auth/osintverse/device", async (c) => {
    const form = await c.req.parseBody();
    const code = normalizeCode(String(form.code ?? ""));
    const row = await c.env.DB.prepare(`SELECT id FROM device_logins WHERE user_code = ? AND provider = 'osintverse' AND status = 'pending' AND expires_at > ?`)
      .bind(code, Date.now()).first<{ id: string }>();
    if (!row) return c.html(codeForm(`<p><strong>That code isn't valid or has expired.</strong> Check it, or run <code>ot login --osintverse</code> again.</p>`), 400);
    return osintverseLogin(c, `${c.env.SITE_URL}/dashboard`, row.id);
  });

  app.post("/auth/osintverse/device/confirm", async (c) => {
    const form = await c.req.parseBody();
    const id = String(form.id ?? "");
    const confirm = String(form.confirm ?? "");
    if (!id || !confirm) apiError(400, "invalid_body", "the approval form is incomplete");
    const decision = form.decision === "approve" ? "approved" : "denied";
    const r = await c.env.DB.prepare(
      `UPDATE device_logins SET status = ?, confirm_token_hash = NULL WHERE id = ? AND status = 'authorized' AND confirm_token_hash = ? AND expires_at > ?`,
    ).bind(decision, id, await sha256Hex(confirm), Date.now()).run();
    if (!r.meta.changes) return c.html(devicePage("This code has expired", "<p>Run <code>ot login --osintverse</code> again for a new code.</p>"), 410);
    return c.html(decision === "approved"
      ? devicePage("ot is signed in", "<p>You can close this tab and go back to your terminal.</p>")
      : devicePage("Sign-in denied", "<p>ot was not signed in. You can close this tab.</p>"));
  });
}
