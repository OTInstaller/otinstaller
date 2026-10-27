// Shared results: saved runs that `ot share` and `otlite share` upload (spec/schema/share-v1.json), readable by anyone
// with the link for 24 hours and then deleted. The runs are kept as they were sent, minus the details that only mean
// something on the sharer's machine; viewers never learn who shared them. A signed-in sharer owns the share and can
// list and delete it; anyone holding the delete token handed out at upload can delete it too. The runs live in R2
// CONTENT at shares/<id>.json, the row (migration 0043) in D1. Routes in routes/shares.ts; the purge runs every 15
// minutes from index.ts.
import type { Env, User } from "./env";
import { apiError } from "./lib/errors";
import { randomToken, safeEqual, sha256Hex } from "./lib/crypto";

/** How long a link works. */
export const SHARE_TTL_MS = 24 * 3_600_000;
export const MAX_SHARE_BYTES = 5 * 1_048_576;
export const MAX_SHARE_RUNS = 50;
// Ids are randomToken(16): 22 base64url characters.
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
// Keys of a run that only mean something on the sharer's machine, dropped if a client sends them.
const LOCAL_KEYS = ["run_id", "case", "command", "target", "stderr_path", "meta_path", "output_path"];
const LOCAL_OUTPUT_KEYS = ["path", "meta_path"];

export type ShareSource = "ot" | "otlite";
export type ShareRow = {
  id: string; owner_id: string | null; delete_hash: string; source: ShareSource; run_count: number; tools_json: string;
  bytes: number; created_at: number; expires_at: number;
};

const shareKey = (id: string) => `shares/${id}.json`;

/** The page on the website that shows a share. */
export function shareUrl(env: Env, id: string): string {
  return `${env.SITE_URL.replace(/\/+$/, "")}/r/${id}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function invalid(message: string): never {
  apiError(400, "invalid_body", message, "send what `ot share --dry-run` prints: https://otinstaller.com/schema/share-v1.json");
}

/** Checks an upload against share-v1 and drops the local details from each run. */
export function cleanShare(body: unknown): { source: ShareSource; runs: Record<string, unknown>[] } {
  if (!isObject(body) || body.share !== 1) invalid("send {share: 1, source, runs}");
  const b = body;
  if (b.source !== "ot" && b.source !== "otlite") invalid("source must be ot or otlite");
  if (!Array.isArray(b.runs) || b.runs.length === 0) invalid("runs must list at least one run");
  const list = b.runs as unknown[];
  if (list.length > MAX_SHARE_RUNS) invalid(`at most ${MAX_SHARE_RUNS} runs in one share`);
  const runs = list.map((r, i) => {
    if (!isObject(r)) invalid(`runs[${i}] is not an object`);
    const run = { ...r };
    const str = (k: string, max: number) => typeof run[k] === "string" && (run[k] as string).length > 0 && (run[k] as string).length <= max;
    if (!str("tool", 200)) invalid(`runs[${i}].tool must be the tool that ran, as name@version`);
    if (!str("runtime", 20)) invalid(`runs[${i}].runtime must say how it ran`);
    if (!isObject(run.input) || Object.values(run.input).some((v) => typeof v !== "string")) invalid(`runs[${i}].input must map input names to strings`);
    if (!Array.isArray(run.entities) || run.entities.some((e) => !isObject(e) || typeof e.type !== "string" || typeof e.value !== "string")) {
      invalid(`runs[${i}].entities must be a list of {type, value}`);
    }
    if (run.warnings !== undefined && (!Array.isArray(run.warnings) || run.warnings.some((w) => typeof w !== "string"))) invalid(`runs[${i}].warnings must be a list of strings`);
    for (const k of LOCAL_KEYS) delete run[k];
    if (isObject(run.output)) {
      const output = { ...run.output };
      for (const k of LOCAL_OUTPUT_KEYS) delete output[k];
      run.output = output;
    }
    return run;
  });
  return { source: b.source as ShareSource, runs };
}

/** Stores an upload (its JSON text, already size-checked) and answers with the link and the delete token. */
export async function createShare(env: Env, user: User | null, text: string, now = Date.now()) {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    invalid("the upload is not JSON");
  }
  const { source, runs } = cleanShare(body);
  const stored = JSON.stringify({ share: 1, source, runs });
  const bytes = new TextEncoder().encode(stored).byteLength;
  const id = randomToken(16);
  const token = randomToken(32);
  const expiresAt = now + SHARE_TTL_MS;
  const tools = runs.map((r) => r.tool as string);
  await env.DB.prepare(
    `INSERT INTO shares (id, owner_id, delete_hash, source, run_count, tools_json, bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user?.id ?? null, await sha256Hex(token), source, runs.length, JSON.stringify(tools), bytes, now, expiresAt).run();
  try {
    await env.CONTENT.put(shareKey(id), stored, { httpMetadata: { contentType: "application/json" } });
  } catch (e) {
    await env.DB.prepare(`DELETE FROM shares WHERE id = ?`).bind(id).run();
    throw e;
  }
  return { id, url: shareUrl(env, id), created_at: now, expires_at: expiresAt, delete_token: token, owned: user !== null, runs: runs.length, tools };
}

async function findShare(env: Env, id: string): Promise<ShareRow | null> {
  if (!SHARE_ID.test(id)) return null;
  return env.DB.prepare(`SELECT * FROM shares WHERE id = ?`).bind(id).first<ShareRow>();
}

function notFound(): never {
  apiError(404, "share_not_found", "no such shared result", "links stop working 24 hours after they are made, or when the sharer deletes them");
}

/** A live share's runs, as anyone with the link sees them: nothing about who shared it. */
export async function readShare(env: Env, id: string, now = Date.now()) {
  const row = await findShare(env, id);
  if (!row) notFound();
  if (row.expires_at <= now) apiError(410, "share_expired", "this shared result has expired", "shared results are kept for 24 hours; ask for a new link");
  const obj = await env.CONTENT.get(shareKey(row.id));
  if (!obj) notFound();
  const stored = (await obj.json()) as { runs: unknown[] };
  return { id: row.id, source: row.source, created_at: row.created_at, expires_at: row.expires_at, runs: stored.runs };
}

/** Deletes a share for its owner, or for whoever holds its delete token. */
export async function deleteShare(env: Env, user: User | null, id: string, token: unknown) {
  const row = await findShare(env, id);
  if (!row) notFound();
  const owner = user !== null && row.owner_id === user.id;
  const holder = typeof token === "string" && token.length > 0 && safeEqual(await sha256Hex(token), row.delete_hash);
  if (!owner && !holder) {
    apiError(403, "share_forbidden", "only the person who shared this can delete it",
      row.owner_id ? "sign in as the account that shared it" : "send the delete_token `ot share` or `otlite share` printed");
  }
  await removeShares(env, [row.id]);
}

/** Deletes shares' rows and their stored runs. */
export async function removeShares(env: Env, ids: string[]) {
  if (ids.length === 0) return;
  await env.CONTENT.delete(ids.map(shareKey));
  await env.DB.prepare(`DELETE FROM shares WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).run();
}

/** A signed-in person's shares that still work, newest first. */
export async function listShares(env: Env, user: User, now = Date.now()) {
  const rows = (await env.DB.prepare(
    `SELECT id, source, run_count, tools_json, bytes, created_at, expires_at FROM shares WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(user.id, now).all<Omit<ShareRow, "owner_id" | "delete_hash">>()).results;
  return rows.map(({ tools_json, ...r }) => ({ ...r, url: shareUrl(env, r.id), tools: JSON.parse(tools_json) as string[] }));
}

/** Deletes expired shares, 200 a run; the 15-minute cron calls it. */
export async function purgeExpiredShares(env: Env, now = Date.now()) {
  const ids = (await env.DB.prepare(`SELECT id FROM shares WHERE expires_at <= ? ORDER BY expires_at LIMIT 200`).bind(now).all<{ id: string }>()).results.map((r) => r.id);
  await removeShares(env, ids);
  return ids.length;
}
