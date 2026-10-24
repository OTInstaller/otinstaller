// Source and artifact backups: if GitHub or GitLab bans or takes down a repository by mistake, installs keep
// working and the code is not lost.
//
//   image  each published Docker version, copied with its signatures to the mirror (mirror.otinstaller.com) by
//          the scanner after a passing verdict (crane copy keeps the digest, so cosign verifies the same signature).
//          An image a publisher pushed to the mirror itself is not copied: its row is the image (hosted = 1)
//   wheel  each published pipx version's wheel, in R2 at wheels/<ns>/<name>/<sha256>.whl
//   git    a git bundle of a mirror clone (all branches and tags) at every release and weekly, in R2 at
//          git/<provider>/<project_id>/<date>-<version|weekly>.bundle
//
// The scanner does the copying. With each job the registry hands it short-lived signed upload URLs and a
// single-use token for reporting back (POST /v1/internal/backups/<run>), and the registry checks what arrived.
//
// Rules: only public repositories of published packages; 500 MB per bundle and 2 GB per image (bigger ones are
// skipped and the owner is told; the other artifacts are still kept); mirrors are public only for OSI-approved
// licenses (others are kept privately, for restores); takedowns delete backups after 14 days unless a legal hold
// applies; owners can opt out of git backups.
import { requireSecret, type Env } from "./env";
import { randomToken, sha256Hex, ulid } from "./lib/crypto";
import type { Manifest } from "./lib/manifest";
import { apiObjectUrl, presignSigV4 } from "./lib/presign";
import { deleteImage, hideImage, imageExists, purgeUploads, releaseImage, sweepRepo } from "./mirror/registry";
import { dispatchOps } from "./scans";
import { audit } from "./routes/auth";
import { ownerEmails, sendEmail, staffEmails, templates } from "./notify";

export const MAX_BUNDLE_BYTES = 500 * 1024 ** 2;
export const MAX_IMAGE_BYTES = 2 * 1024 ** 3;
export const MAX_WHEEL_BYTES = 1024 ** 3;
export const RELEASE_TTL = 3 * 3600_000;
export const WEEKLY_TTL = 12 * 3600_000;
export const DOWNLOAD_TTL = 3600;
export const KEEP_WEEKLY = 4;
/** Taken-down backups are deleted this long after the removal: 14 days, well inside the policy's "within 30 days". */
export const TAKEDOWN_GRACE = 14 * 86_400_000;
export const DRILL_TTL = 6 * 3600_000;
const WEEKLY_PER_DISPATCH = 20;
// Cron triggers (wrangler.jsonc): weekly git backups on Mondays, the restore drill on the 1st of the month.
export const WEEKLY_BACKUP_CRON = "41 4 * * 1";
export const RESTORE_DRILL_CRON = "23 5 1 * *";

// SPDX identifiers of OSI-approved licenses (opensource.org/licenses), including the -only/-or-later forms.
const OSI = new Set([
  "0BSD", "AFL-3.0", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-1.1", "Apache-2.0", "APSL-2.0", "Artistic-2.0",
  "BSD-1-Clause", "BSD-2-Clause", "BSD-2-Clause-Patent", "BSD-3-Clause", "BSD-3-Clause-LBNL", "BSL-1.0", "CDDL-1.0", "CECILL-2.1",
  "CPAL-1.0", "ECL-2.0", "EFL-2.0", "EPL-1.0", "EPL-2.0", "EUPL-1.1", "EUPL-1.2", "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later",
  "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0",
  "LGPL-3.0-only", "LGPL-3.0-or-later", "LPL-1.02", "MIT", "MIT-0", "MPL-1.1", "MPL-2.0", "MPL-2.0-no-copyleft-exception",
  "MS-PL", "MS-RL", "MulanPSL-2.0", "NCSA", "OFL-1.1", "OSL-3.0", "PHP-3.01", "PostgreSQL", "Python-2.0", "QPL-1.0", "RPL-1.5",
  "UPL-1.0", "Unicode-DFS-2016", "Unlicense", "W3C", "Zlib", "ZPL-2.1", "BlueOak-1.0.0", "CAL-1.0", "OLDAP-2.8", "Vim",
]);

/** Whether an SPDX expression is OSI-approved: any OR branch whose AND parts are all approved (WITH exceptions allowed). */
export function osiApproved(expr: string | null | undefined): boolean {
  if (!expr) return false;
  const flat = expr.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return flat.split(/ OR /i).some((branch) =>
    branch.split(/ AND /i).every((part) => OSI.has(part.split(/ WITH /i)[0]!.trim().replace(/\+$/, ""))));
}

export const mirrorHost = (env: Env) => env.MIRROR_HOST ?? "mirror.otinstaller.com";
export const mirrorRepo = (ns: string, name: string, isPublic: boolean) => `${isPublic ? "" : "private/"}${ns}/${name}`;

/** The mirror repository and digest of an image that lives on the mirror itself (`ot publish --image`), else null. */
export function hostedImage(env: Env, image: string | undefined): { repo: string; digest: string } | null {
  const prefix = `${mirrorHost(env)}/`;
  if (!image?.startsWith(prefix) || !image.includes("@sha256:")) return null;
  const rest = image.slice(prefix.length);
  return { repo: rest.slice(0, rest.indexOf("@")), digest: rest.slice(rest.indexOf("@") + 1) };
}
const splitLocation = (loc: string) => {
  const at = loc.lastIndexOf("@");
  return { repo: loc.slice(0, at), digest: loc.slice(at + 1) };
};

/** A signed URL for one object in the backups bucket. */
export async function signedUrl(env: Env, method: "GET" | "PUT", key: string, ttlSeconds: number, now = Date.now()): Promise<string> {
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return presignSigV4({
      method, host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${env.BACKUPS_BUCKET ?? "otinstaller-backups"}/${key}`, region: "auto",
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, expiresSeconds: ttlSeconds, now: new Date(now),
    });
  }
  return apiObjectUrl(env.API_URL, requireSecret(env, "TOKEN_ENC_KEY"), method, key, Math.floor(now / 1000) + ttlSeconds);
}

// ---------- what to back up ----------

type ToolCtx = {
  tool_id: string;
  namespace: string;
  namespace_id: string;
  name: string;
  kind: string;
  tool_status: string;
  git_backups: number;
  legal_hold: number;
  provider: "github" | "gitlab" | null;
  project_id: string | null;
  path: string | null;
  url: string | null;
  visibility: string | null;
  sync_status: string | null;
};

async function toolCtx(env: Env, toolId: string): Promise<ToolCtx | null> {
  return env.DB.prepare(
    `SELECT t.id AS tool_id, n.name AS namespace, n.id AS namespace_id, t.name, t.kind, t.status AS tool_status, t.git_backups, t.legal_hold,
       s.provider, s.project_id, s.path, s.url, s.visibility, s.sync_status
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id LEFT JOIN sources s ON s.tool_id = t.id WHERE t.id = ?`,
  ).bind(toolId).first<ToolCtx>();
}

/** Git backups need a public repository the registry can still reach (private repositories are never backed up). */
export function gitEligible(t: ToolCtx): boolean {
  return t.git_backups === 1 && !!t.provider && !!t.url && t.sync_status !== "unavailable" && (t.visibility ?? "public") === "public";
}

const cloneUrl = (t: ToolCtx) => (/^https:\/\/(github|gitlab)\.com\//.test(t.url!) ? `${t.url!.replace(/\/+$/, "")}.git` : t.url!);

type Planned =
  | { kind: "image"; location: string; visibility: "public" | "private"; source: string; target: string; digest: string }
  | { kind: "wheel"; location: string; visibility: "public" | "private"; sha256: string; package: string; version: string }
  | { kind: "git"; location: string; clone_url: string; weekly: boolean };

export type PlanItem = { id: string; kind: Planned["kind"]; max_bytes: number } & Record<string, unknown>;
export type BackupPlan = { run_id: string; ref: string; complete_url: string; token: string; expires_at: number; items: PlanItem[] };

const MAX = { image: MAX_IMAGE_BYTES, wheel: MAX_WHEEL_BYTES, git: MAX_BUNDLE_BYTES } as const;

async function createRun(env: Env, t: ToolCtx, versionId: string | null, trigger: "release" | "weekly" | "manual", planned: Planned[], ttl: number, now = Date.now()): Promise<BackupPlan> {
  const runId = ulid(now);
  const token = randomToken(32);
  const expires = now + ttl;
  const stmts = [
    env.DB.prepare(`INSERT INTO backup_runs (id, tool_id, version_id, trigger, token_hash, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(runId, t.tool_id, versionId, trigger, await sha256Hex(token), expires, now),
  ];
  const items: PlanItem[] = [];
  for (const p of planned) {
    const id = ulid(now);
    const visibility = p.kind === "git" ? "private" : p.visibility;
    stmts.push(env.DB.prepare(
      `INSERT INTO backups (id, run_id, tool_id, version_id, kind, location, visibility, weekly, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(id, runId, t.tool_id, versionId, p.kind, p.location, visibility, p.kind === "git" && p.weekly ? 1 : 0, now));
    const base = { id, kind: p.kind, max_bytes: MAX[p.kind] };
    if (p.kind === "image") items.push({ ...base, source: p.source, target: p.target, digest: p.digest, visibility: p.visibility });
    else if (p.kind === "wheel") items.push({ ...base, key: p.location, sha256: p.sha256, package: p.package, version: p.version, upload_url: await signedUrl(env, "PUT", p.location, Math.ceil(ttl / 1000), now) });
    else items.push({ ...base, key: p.location, clone_url: p.clone_url, upload_url: await signedUrl(env, "PUT", p.location, Math.ceil(ttl / 1000), now) });
  }
  await env.DB.batch(stmts);
  return { run_id: runId, ref: `${t.namespace}/${t.name}`, complete_url: `${env.API_URL}/v1/internal/backups/${runId}`, token, expires_at: expires, items };
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * The backups of a published version: its image or wheel, and a git bundle. Null when there is nothing to do
 * (a removed package, or everything is already stored).
 */
export async function releasePlan(env: Env, versionId: string, trigger: "release" | "manual" = "release", now = Date.now()): Promise<BackupPlan | null> {
  const v = await env.DB.prepare(`SELECT id, tool_id, version, status, manifest_json FROM versions WHERE id = ?`)
    .bind(versionId).first<{ id: string; tool_id: string; version: string; status: string; manifest_json: string }>();
  if (!v || !["published", "yanked"].includes(v.status)) return null;
  const t = await toolCtx(env, v.tool_id);
  if (!t || t.tool_status === "removed") return null;
  const m = JSON.parse(v.manifest_json) as Manifest;
  const isPublic = osiApproved(m.license as string | undefined);
  const visibility = isPublic ? "public" : "private";
  const stored = new Set((await env.DB.prepare(`SELECT kind FROM backups WHERE version_id = ? AND status = 'stored'`).bind(v.id).all<{ kind: string }>()).results.map((r) => r.kind));
  const planned: Planned[] = [];
  const rt = m.runtime as { kind?: string; image?: string; package?: string; package_version?: string; wheel_sha256?: string } | undefined;
  // An image that lives on the mirror already is its own copy (recordHostedImage).
  if (rt?.kind === "docker" && rt.image?.includes("@sha256:") && !stored.has("image") && !hostedImage(env, rt.image)) {
    const digest = rt.image.slice(rt.image.indexOf("@") + 1);
    const repo = mirrorRepo(t.namespace, t.name, isPublic);
    planned.push({ kind: "image", location: `${repo}@${digest}`, visibility, source: rt.image, target: `${mirrorHost(env)}/${repo}`, digest });
  }
  if (rt?.kind === "pipx" && rt.wheel_sha256 && rt.package && !stored.has("wheel")) {
    planned.push({ kind: "wheel", location: `wheels/${t.namespace}/${t.name}/${rt.wheel_sha256}.whl`, visibility, sha256: rt.wheel_sha256, package: rt.package, version: rt.package_version ?? m.version });
  }
  if (gitEligible(t) && !stored.has("git")) {
    planned.push({ kind: "git", location: `git/${t.provider}/${t.project_id}/${day(now)}-v${v.version}.bundle`, clone_url: cloneUrl(t), weekly: false });
  }
  if (planned.length === 0) return null;
  return createRun(env, t, v.id, trigger, planned, RELEASE_TTL, now);
}

/** Sends backup jobs to the scanner workflow; jobs whose dispatch failed are marked failed. */
export async function dispatchBackups(env: Env, plans: BackupPlan[]) {
  if (plans.length === 0) return;
  const ids = plans.map((p) => p.run_id);
  const marks = (status: string, error: string | null) => env.DB.batch(ids.flatMap((id) => [
    env.DB.prepare(`UPDATE backup_runs SET status = ?, error = ? WHERE id = ?`).bind(status, error, id),
    ...(status === "failed" ? [env.DB.prepare(`UPDATE backups SET status = 'failed', detail = ? WHERE run_id = ? AND status = 'pending'`).bind(error, id)] : []),
  ]));
  try {
    await dispatchOps(env, "otinstaller-backup", { backup: { jobs: plans } });
  } catch (e) {
    await marks("failed", (e as Error).message.slice(0, 300));
    throw e;
  }
  await marks("dispatched", null);
}

/** Queue work: back up a version that was published without a scanner run doing it (approved releases, guides). */
export async function backupVersion(env: Env, versionId: string) {
  const plan = await releasePlan(env, versionId);
  if (plan) await dispatchBackups(env, [plan]);
}

export const BACKFILL_PER_RUN = 5;
export const BACKFILL_RETRY = 86_400_000;

/**
 * Every 15 minutes: published versions whose image or wheel is not backed up yet (published before backups
 * existed, or whose backup failed) get a backup job, a few at a time and at most once a day each.
 */
export async function backfillBackups(env: Env, now = Date.now(), limit = BACKFILL_PER_RUN): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT v.id FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE v.status IN ('published', 'yanked') AND v.runtime_kind IN ('docker', 'pipx') AND t.status != 'removed' AND n.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.version_id = v.id AND b.kind IN ('image', 'wheel') AND b.status IN ('stored', 'pending', 'too_large'))
       AND NOT EXISTS (SELECT 1 FROM backup_runs r WHERE r.version_id = v.id AND r.created_at > ?)
     ORDER BY v.published_at DESC LIMIT ?`,
  ).bind(now - BACKFILL_RETRY, limit).all<{ id: string }>()).results;
  const plans: BackupPlan[] = [];
  for (const r of rows) {
    const plan = await releasePlan(env, r.id, "manual", now);
    if (plan) plans.push(plan);
  }
  if (plans.length) await dispatchBackups(env, plans).catch((e) => console.error("backfill dispatch failed", e));
  return plans.length;
}

/** Weekly: a git backup of every active source, so code pushed between releases is covered. */
export async function weeklyBackups(env: Env, now = Date.now()): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN sources s ON s.tool_id = t.id
     WHERE t.status != 'removed' AND t.latest_version_id IS NOT NULL AND n.status = 'active' AND t.git_backups = 1
       AND s.sync_status NOT IN ('unavailable', 'paused') AND COALESCE(s.visibility, 'public') = 'public'
     ORDER BY t.id`,
  ).all<{ id: string }>()).results;
  const plans: BackupPlan[] = [];
  for (const r of rows) {
    const t = await toolCtx(env, r.id);
    if (!t || !gitEligible(t)) continue;
    plans.push(await createRun(env, t, null, "weekly",
      [{ kind: "git", location: `git/${t.provider}/${t.project_id}/${day(now)}-weekly.bundle`, clone_url: cloneUrl(t), weekly: true }], WEEKLY_TTL, now));
  }
  for (let i = 0; i < plans.length; i += WEEKLY_PER_DISPATCH) {
    // One failed batch should not stop the rest.
    await dispatchBackups(env, plans.slice(i, i + WEEKLY_PER_DISPATCH)).catch((e) => console.error("weekly backup dispatch failed", e));
  }
  return plans.length;
}

// ---------- the scanner reports back ----------

export type ReportedItem = { id: string; status: "stored" | "too_large" | "failed"; size_bytes?: number; sha256?: string; filename?: string; refs_count?: number; detail?: string };

type BackupRow = { id: string; run_id: string; tool_id: string; version_id: string | null; kind: "git" | "wheel" | "image"; location: string; visibility: string; weekly: number };

export class BackupError extends Error {
  constructor(public status: 400 | 401 | 404 | 409 | 410, public code: string, message: string) {
    super(message);
  }
}

/** Applies the scanner's report on one run. Its token works once. */
export async function completeRun(env: Env, runId: string, token: string, reported: ReportedItem[], now = Date.now()) {
  const db = env.DB;
  const run = await db.prepare(
    `SELECT id, tool_id, version_id FROM backup_runs WHERE id = ? AND token_hash = ? AND expires_at > ? AND status IN ('pending', 'dispatched')`,
  ).bind(runId, await sha256Hex(token), now).first<{ id: string; tool_id: string; version_id: string | null }>();
  if (!run) throw new BackupError(401, "invalid_backup_token", "unknown, expired or already used backup token");
  const rows = (await db.prepare(`SELECT id, run_id, tool_id, version_id, kind, location, visibility, weekly FROM backups WHERE run_id = ?`).bind(runId).all<BackupRow>()).results;
  const byId = new Map(reported.map((r) => [r.id, r]));
  const version = run.version_id
    ? await db.prepare(`SELECT manifest_json FROM versions WHERE id = ?`).bind(run.version_id).first<{ manifest_json: string }>()
    : null;
  const wheelSha = version ? ((JSON.parse(version.manifest_json) as Manifest).runtime as { wheel_sha256?: string } | undefined)?.wheel_sha256 : undefined;

  const stmts: D1PreparedStatement[] = [];
  const tooLarge: { kind: string; size_bytes: number | null }[] = [];
  const outcome: Record<string, string> = {};
  for (const row of rows) {
    const r = byId.get(row.id);
    let status: "stored" | "too_large" | "failed" = r?.status ?? "failed";
    let detail = r?.detail?.slice(0, 500) ?? (r ? null : "not reported by the scanner");
    let size = typeof r?.size_bytes === "number" ? r.size_bytes : null;
    const max = MAX[row.kind];
    if (status === "stored" && row.kind !== "image") {
      // Check what actually arrived: an object of an allowed size, and for wheels the manifest's hash.
      const obj = await env.BACKUPS.head(row.location);
      if (!obj) [status, detail] = ["failed", "the upload did not arrive"];
      else {
        size = obj.size;
        if (obj.size > max) {
          await env.BACKUPS.delete(row.location);
          [status, detail] = ["too_large", `${obj.size} bytes is over the ${max}-byte limit`];
        } else if (row.kind === "wheel" && wheelSha && r?.sha256 !== wheelSha) {
          await env.BACKUPS.delete(row.location);
          [status, detail] = ["failed", "the uploaded wheel's SHA-256 does not match the manifest"];
        }
      }
    } else if (status === "stored" && row.kind === "image") {
      const { repo, digest } = splitLocation(row.location);
      if (!(await imageExists(env.MIRROR, repo, digest))) [status, detail] = ["failed", "the image is not in the mirror"];
      else if (size !== null && size > max) {
        await deleteImage(env.MIRROR, repo, digest);
        [status, detail] = ["too_large", `${size} bytes is over the ${max}-byte limit`];
      }
    }
    if (status === "too_large") tooLarge.push({ kind: row.kind, size_bytes: size });
    outcome[row.kind] = status;
    stmts.push(db.prepare(
      `UPDATE backups SET status = ?, size_bytes = ?, sha256 = ?, filename = ?, refs_count = ?, detail = ?, stored_at = ? WHERE id = ?`,
    ).bind(status, size, status === "stored" ? r?.sha256 ?? null : null, r?.filename?.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 200) || null,
      typeof r?.refs_count === "number" ? r.refs_count : null, detail, status === "stored" ? now : null, row.id));
  }
  stmts.push(
    db.prepare(`UPDATE backup_runs SET status = 'completed', token_hash = NULL, completed_at = ? WHERE id = ?`).bind(now, runId),
    audit(db, null, "system", "backup.completed", "tool", run.tool_id, { run: runId, ...outcome }),
  );
  await db.batch(stmts);

  // A takedown that happened while the scanner was copying applies to what it just stored.
  const removed = await db.prepare(
    `SELECT 1 FROM tools t LEFT JOIN versions v ON v.id = ? WHERE t.id = ? AND (t.status = 'removed' OR v.status = 'removed')`,
  ).bind(run.version_id, run.tool_id).first();
  if (removed) await scheduleDeletion(env, run.tool_id, run.version_id, now);
  await pruneWeekly(env, run.tool_id, now);

  if (tooLarge.length) {
    const t = await toolCtx(env, run.tool_id);
    if (t) {
      await sendEmail(env, {
        to: await ownerEmails(env, t.namespace_id), kind: "backup_too_large", key: `backup-too-large:${runId}`,
        ...templates.backupTooLarge(env, `${t.namespace}/${t.name}`, tooLarge),
      });
    }
  }
  return { status: "completed", items: outcome };
}

/** Keeps the last KEEP_WEEKLY weekly bundles of a package; release bundles are all kept. */
export async function pruneWeekly(env: Env, toolId: string, now = Date.now()) {
  const old = (await env.DB.prepare(
    `SELECT id, location FROM backups WHERE tool_id = ? AND kind = 'git' AND weekly = 1 AND status = 'stored' ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
  ).bind(toolId, KEEP_WEEKLY).all<{ id: string; location: string }>()).results;
  if (!old.length) return 0;
  await env.BACKUPS.delete(old.map((o) => o.location));
  await env.DB.batch(old.map((o) => env.DB.prepare(`UPDATE backups SET status = 'deleted', deleted_at = ?, detail = 'superseded by newer weekly bundles' WHERE id = ?`).bind(now, o.id)));
  return old.length;
}

/** Runs whose scanner never reported back. */
export async function expireRuns(env: Env, now = Date.now()) {
  const stale = (await env.DB.prepare(`SELECT id FROM backup_runs WHERE status IN ('pending', 'dispatched') AND expires_at < ?`).bind(now).all<{ id: string }>()).results;
  if (!stale.length) return 0;
  await env.DB.batch(stale.flatMap((r) => [
    env.DB.prepare(`UPDATE backup_runs SET status = 'expired', token_hash = NULL WHERE id = ?`).bind(r.id),
    env.DB.prepare(`UPDATE backups SET status = 'failed', detail = 'the backup job did not report back' WHERE run_id = ? AND status = 'pending'`).bind(r.id),
  ]));
  return stale.length;
}

// ---------- images hosted on the mirror ----------

/**
 * A published version whose image a publisher pushed to the mirror (`ot publish --image`): the image goes public
 * (releaseImage clears its pending marker) and gets an image backup row that is the image itself (hosted = 1), so
 * takedowns hide it, purges delete it and legal holds keep it like any mirrored copy. Never an install fallback.
 */
export async function recordHostedImage(env: Env, versionId: string, toolId: string, image: string, now = Date.now()) {
  const hosted = hostedImage(env, image);
  if (!hosted) return false;
  await releaseImage(env.MIRROR, hosted.repo, hosted.digest);
  const location = `${hosted.repo}@${hosted.digest}`;
  const have = await env.DB.prepare(`SELECT 1 FROM backups WHERE version_id = ? AND kind = 'image' AND location = ? AND status = 'stored'`).bind(versionId, location).first();
  if (!have) {
    await env.DB.prepare(
      `INSERT INTO backups (id, tool_id, version_id, kind, location, visibility, status, hosted, created_at, stored_at) VALUES (?, ?, ?, 'image', ?, 'public', 'stored', 1, ?, ?)`,
    ).bind(ulid(now), toolId, versionId, location, now, now).run();
  }
  return true;
}

/** Image pushes the nightly clean-up looks at once they are this old: by then the release they were for is decided. */
export const MIRROR_SWEEP_AGE = 7 * 86_400_000;

/**
 * Nightly: queues a sweep of each mirror repository publishers pushed to more than a week ago (50 a night, one per
 * queue message, since a sweep lists the whole repository), and clears blob uploads nobody finished.
 */
export async function queueMirrorSweeps(env: Env, now = Date.now()) {
  const repos = (await env.DB.prepare(`SELECT DISTINCT repo FROM mirror_pushes WHERE created_at < ? LIMIT 50`).bind(now - MIRROR_SWEEP_AGE).all<{ repo: string }>()).results;
  if (repos.length) await env.PUBLISH_QUEUE.sendBatch(repos.map((r) => ({ body: { mirrorSweepRepo: r.repo } })));
  await purgeUploads(env.MIRROR, { now });
  return repos.length;
}

/**
 * Removes images publishers pushed to a repository that no version uses: everything but the digests of the package's
 * versions that weren't rejected (on any host) and of its backups, with what hangs off them, is deleted once a
 * week old. The repository's old push records go with it.
 */
export async function sweepMirrorRepo(env: Env, repo: string, now = Date.now()) {
  const [ns, name] = repo.split("/");
  const refs = (await env.DB.prepare(
    `SELECT v.artifact_ref AS ref FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE n.name = ? AND t.name = ? AND v.status != 'rejected' AND v.artifact_ref LIKE '%@sha256:%'
     UNION SELECT location AS ref FROM backups WHERE location LIKE ? AND status != 'deleted'`,
  ).bind(ns, name, `${repo}@sha256:%`).all<{ ref: string }>()).results;
  const keep = new Set(refs.map((r) => r.ref.slice(r.ref.indexOf("@") + 1)));
  const out = await sweepRepo(env.MIRROR, repo, keep, { now });
  await env.DB.prepare(`DELETE FROM mirror_pushes WHERE repo = ? AND created_at < ?`).bind(repo, now - MIRROR_SWEEP_AGE).run();
  return out;
}

// ---------- installs and restores ----------

/** Where ot can get a version when its original registry refuses: the public mirror and the R2 copy of the wheel. */
export async function installFallbacks(env: Env, versionId: string, ns: string, name: string, version: string) {
  const rows = (await env.DB.prepare(
    `SELECT kind, location, filename FROM backups WHERE version_id = ? AND kind IN ('image', 'wheel') AND status = 'stored' AND visibility = 'public' AND delete_after IS NULL AND hosted = 0`,
  ).bind(versionId).all<{ kind: string; location: string; filename: string | null }>()).results;
  const out: { mirror_image?: string; wheel_url?: string } = {};
  for (const r of rows) {
    if (r.kind === "image") out.mirror_image = `${mirrorHost(env)}/${r.location}`;
    if (r.kind === "wheel") out.wheel_url = `${env.API_URL}/v1/tools/${ns}/${name}/${version}/wheel/${r.filename ?? `${name}-${version}-py3-none-any.whl`}`;
  }
  return out;
}

export async function latestBundle(env: Env, toolId: string) {
  return env.DB.prepare(
    `SELECT id, location, size_bytes, sha256, refs_count, weekly, created_at, stored_at FROM backups
     WHERE tool_id = ? AND kind = 'git' AND status = 'stored' AND delete_after IS NULL ORDER BY stored_at DESC, created_at DESC LIMIT 1`,
  ).bind(toolId).first<{ id: string; location: string; size_bytes: number | null; sha256: string | null; refs_count: number | null; weekly: number; created_at: number; stored_at: number }>();
}

/** A download link for the latest bundle, and how to push it to a new repository. */
export async function restoreLink(env: Env, toolId: string, actorId: string, now = Date.now()) {
  const t = await toolCtx(env, toolId);
  if (!t) throw new BackupError(404, "tool_not_found", "no such package");
  if (t.tool_status === "removed") throw new BackupError(410, "tool_removed", "removed packages cannot be restored from backup");
  const b = await latestBundle(env, toolId);
  if (!b) throw new BackupError(404, "no_backup", `${t.namespace}/${t.name} has no git backup yet`);
  const filename = `${t.name}-${new Date(b.stored_at ?? b.created_at).toISOString().slice(0, 10)}.bundle`;
  await audit(env.DB, actorId, "user", "backup.restore_link", "tool", toolId, { backup: b.id }).run();
  return {
    url: await signedUrl(env, "GET", b.location, DOWNLOAD_TTL, now),
    expires_at: now + DOWNLOAD_TTL * 1000,
    filename,
    size_bytes: b.size_bytes,
    sha256: b.sha256,
    refs: b.refs_count,
    created_at: b.stored_at ?? b.created_at,
    weekly: b.weekly === 1,
    steps: [
      `curl -fLo ${filename} "<url>"`,
      `git bundle verify ${filename}`,
      `git clone --mirror ${filename} ${t.name}.git`,
      `cd ${t.name}.git && git remote set-url origin <new repository URL>`,
      `git push --mirror`,
      `Then switch the package's source to the new repository: Switch source on the dashboard, or POST /v1/packages/${t.namespace}/${t.name}/source`,
    ],
  };
}

// ---------- takedowns, legal holds and opt-outs ----------

/**
 * A removed version (or, without one, a removed package) stops being served from the mirror and the wheel route
 * at once; its backups are deleted after TAKEDOWN_GRACE by purgeBackups, unless the package is on legal hold.
 */
export async function scheduleDeletion(env: Env, toolId: string, versionId: string | null, now = Date.now()) {
  const db = env.DB;
  const t = await toolCtx(env, toolId);
  if (!t) return 0;
  const rows = (await db.prepare(
    `SELECT id, kind, location FROM backups WHERE tool_id = ? AND status != 'deleted' AND (? IS NULL OR version_id = ?)`,
  ).bind(toolId, versionId, versionId).all<{ id: string; kind: string; location: string }>()).results;
  for (const r of rows.filter((r) => r.kind === "image")) {
    const { repo, digest } = splitLocation(r.location);
    await hideImage(env.MIRROR, repo, digest);
  }
  if (!versionId) {
    await hideImage(env.MIRROR, mirrorRepo(t.namespace, t.name, true), null);
    await hideImage(env.MIRROR, mirrorRepo(t.namespace, t.name, false), null);
  }
  if (rows.length && !t.legal_hold) {
    await db.batch(rows.map((r) => db.prepare(`UPDATE backups SET delete_after = COALESCE(delete_after, ?) WHERE id = ?`).bind(now + TAKEDOWN_GRACE, r.id)));
  }
  return rows.length;
}

async function deleteBackup(env: Env, r: { id: string; kind: string; location: string }, now: number, why: string) {
  if (r.kind === "image") {
    const { repo, digest } = splitLocation(r.location);
    // A publisher may be pushing another image to the same repository right now: blobs from the last day stay.
    await deleteImage(env.MIRROR, repo, digest, { minAgeMs: 86_400_000, now });
  } else {
    await env.BACKUPS.delete(r.location);
  }
  await env.DB.prepare(`UPDATE backups SET status = 'deleted', deleted_at = ?, detail = ? WHERE id = ?`).bind(now, why, r.id).run();
}

/** Nightly: deletes backups whose deletion is due, except for packages on legal hold. */
export async function purgeBackups(env: Env, now = Date.now()) {
  const due = (await env.DB.prepare(
    `SELECT b.id, b.kind, b.location FROM backups b JOIN tools t ON t.id = b.tool_id
     WHERE b.delete_after IS NOT NULL AND b.delete_after <= ? AND b.status != 'deleted' AND t.legal_hold = 0 LIMIT 200`,
  ).bind(now).all<{ id: string; kind: string; location: string }>()).results;
  for (const r of due) await deleteBackup(env, r, now, "deleted after a takedown or opt-out");
  return due.length;
}

export async function setLegalHold(env: Env, actorId: string, toolId: string, hold: boolean, reason: string, now = Date.now()) {
  const db = env.DB;
  await db.batch([
    db.prepare(`UPDATE tools SET legal_hold = ?, legal_hold_reason = ? WHERE id = ?`).bind(hold ? 1 : 0, hold ? reason : null, toolId),
    ...(hold ? [db.prepare(`UPDATE backups SET delete_after = NULL WHERE tool_id = ? AND status != 'deleted'`).bind(toolId)] : []),
    audit(db, actorId, "user", hold ? "backup.legal_hold" : "backup.legal_hold_released", "tool", toolId, { reason }),
  ]);
  if (hold) return;
  // Released: whatever was taken down is deleted on the usual schedule again.
  const t = await db.prepare(`SELECT status FROM tools WHERE id = ?`).bind(toolId).first<{ status: string }>();
  if (t?.status === "removed") await scheduleDeletion(env, toolId, null, now);
  else {
    const removed = (await db.prepare(`SELECT id FROM versions WHERE tool_id = ? AND status = 'removed'`).bind(toolId).all<{ id: string }>()).results;
    for (const v of removed) await scheduleDeletion(env, toolId, v.id, now);
  }
  const optedOut = await db.prepare(`SELECT git_backups FROM tools WHERE id = ?`).bind(toolId).first<{ git_backups: number }>();
  if (optedOut?.git_backups === 0) await db.prepare(`UPDATE backups SET delete_after = COALESCE(delete_after, ?) WHERE tool_id = ? AND kind = 'git' AND status != 'deleted'`).bind(now, toolId).run();
}

/** Owners can opt out of git backups; existing bundles are deleted by the next nightly purge. Artifacts stay mirrored. */
export async function setGitBackups(env: Env, actorId: string, toolId: string, enabled: boolean, now = Date.now()) {
  const db = env.DB;
  const t = await db.prepare(`SELECT status, legal_hold FROM tools WHERE id = ?`).bind(toolId).first<{ status: string; legal_hold: number }>();
  const stmts = [
    db.prepare(`UPDATE tools SET git_backups = ? WHERE id = ?`).bind(enabled ? 1 : 0, toolId),
    audit(db, actorId, "user", enabled ? "backup.git_opt_in" : "backup.git_opt_out", "tool", toolId),
  ];
  if (!enabled && !t?.legal_hold) stmts.push(db.prepare(`UPDATE backups SET delete_after = COALESCE(delete_after, ?) WHERE tool_id = ? AND kind = 'git' AND status != 'deleted'`).bind(now, toolId));
  if (enabled && t?.status !== "removed") stmts.push(db.prepare(`UPDATE backups SET delete_after = NULL WHERE tool_id = ? AND kind = 'git' AND status = 'stored'`).bind(toolId));
  await db.batch(stmts);
}

export async function backupSummary(env: Env, toolId: string) {
  const t = await env.DB.prepare(`SELECT git_backups, legal_hold FROM tools WHERE id = ?`).bind(toolId).first<{ git_backups: number; legal_hold: number }>();
  const rows = (await env.DB.prepare(
    `SELECT b.id, b.kind, v.version, b.visibility, b.weekly, b.status, b.size_bytes, b.detail, b.created_at, b.stored_at, b.delete_after
     FROM backups b LEFT JOIN versions v ON v.id = b.version_id WHERE b.tool_id = ? AND b.status != 'deleted' ORDER BY b.created_at DESC LIMIT 50`,
  ).bind(toolId).all()).results;
  const latest = await latestBundle(env, toolId);
  return {
    git_backups: t?.git_backups === 1,
    legal_hold: t?.legal_hold === 1,
    latest_bundle: latest ? { created_at: latest.stored_at ?? latest.created_at, size_bytes: latest.size_bytes, refs: latest.refs_count, weekly: latest.weekly === 1 } : null,
    backups: rows,
  };
}

// ---------- monthly restore drill ----------

/**
 * Picks a random git bundle and a random publicly mirrored image; the scanner workflow restores the bundle into an
 * empty repository and pulls the image by digest (verifying its signature) and reports back. Any failure alerts the admins.
 */
export async function startDrill(env: Env, now = Date.now()) {
  const git = await env.DB.prepare(
    `SELECT b.id, b.location, b.sha256, b.refs_count FROM backups b JOIN tools t ON t.id = b.tool_id
     WHERE b.kind = 'git' AND b.status = 'stored' AND b.delete_after IS NULL AND t.status != 'removed' ORDER BY random() LIMIT 1`,
  ).first<{ id: string; location: string; sha256: string | null; refs_count: number | null }>();
  const image = await env.DB.prepare(
    `SELECT b.id, b.location, v.signer_identity, v.signer_issuer FROM backups b JOIN versions v ON v.id = b.version_id
     WHERE b.kind = 'image' AND b.status = 'stored' AND b.visibility = 'public' AND b.delete_after IS NULL AND v.status = 'published' ORDER BY random() LIMIT 1`,
  ).first<{ id: string; location: string; signer_identity: string | null; signer_issuer: string | null }>();
  if (!git && !image) return null;
  const id = ulid(now);
  const token = randomToken(32);
  await env.DB.prepare(`INSERT INTO restore_drills (id, git_backup_id, image_backup_id, token_hash, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'dispatched', ?)`)
    .bind(id, git?.id ?? null, image?.id ?? null, await sha256Hex(token), now + DRILL_TTL, now).run();
  const drill = {
    id,
    callback_url: `${env.API_URL}/v1/internal/drills/${id}`,
    token,
    bundle: git ? { url: await signedUrl(env, "GET", git.location, Math.ceil(DRILL_TTL / 1000), now), sha256: git.sha256, refs: git.refs_count } : null,
    image: image ? { ref: `${mirrorHost(env)}/${image.location}`, signer_identity: image.signer_identity, signer_issuer: image.signer_issuer } : null,
  };
  try {
    await dispatchOps(env, "otinstaller-drill", { drill });
  } catch (e) {
    await finishDrill(env, id, "fail", `the drill could not be started: ${(e as Error).message}`, now);
    return { id, status: "fail" };
  }
  return { id, status: "dispatched" };
}

async function finishDrill(env: Env, id: string, status: "pass" | "fail" | "expired", detail: string, now: number) {
  await env.DB.prepare(`UPDATE restore_drills SET status = ?, detail = ?, token_hash = NULL, completed_at = ? WHERE id = ?`).bind(status, detail.slice(0, 2000), now, id).run();
  if (status !== "pass") {
    await sendEmail(env, { to: await staffEmails(env, "admins"), kind: "alert", key: `drill:${id}`, ...templates.drillFailed(env, id, status, detail) });
  }
}

export async function completeDrill(env: Env, id: string, token: string, body: { result?: string; detail?: string; checks?: unknown }, now = Date.now()) {
  const d = await env.DB.prepare(`SELECT id FROM restore_drills WHERE id = ? AND token_hash = ? AND status = 'dispatched' AND expires_at > ?`)
    .bind(id, await sha256Hex(token), now).first();
  if (!d) throw new BackupError(401, "invalid_drill_token", "unknown, expired or already used drill token");
  const result = body.result === "pass" ? "pass" : "fail";
  const detail = [body.detail ?? "", body.checks ? JSON.stringify(body.checks) : ""].filter(Boolean).join("\n");
  await finishDrill(env, id, result, detail, now);
  return { status: result };
}

export async function expireDrills(env: Env, now = Date.now()) {
  const stale = (await env.DB.prepare(`SELECT id FROM restore_drills WHERE status = 'dispatched' AND expires_at < ?`).bind(now).all<{ id: string }>()).results;
  for (const d of stale) await finishDrill(env, d.id, "expired", "the restore drill did not report back within 6 hours", now);
  return stale.length;
}
