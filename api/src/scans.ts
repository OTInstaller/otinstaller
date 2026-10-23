// Security scans: dispatch to the scanner (a GitHub Actions workflow in the registry-ops repo),
// verdicts on its results, and publishing.
import { deps, requireSecret, type Env } from "./env";
import { randomToken, sha256Hex, ulid } from "./lib/crypto";
import type { Manifest } from "./lib/manifest";
import * as github from "./hosts/github";
import { githubRepo, gitlabRepo, type CommitState } from "./hosts/repo";
import { audit } from "./routes/auth";
import { ownerEmails, sendEmail, templates } from "./notify";
import { updateLinkHealth } from "./guides";
import { announceVersion } from "./community";
import { linkPublished } from "./requests";
import { firstReleasePublished, firstReleaseScanned } from "./submissions";

export const SCAN_TOKEN_TTL = 60 * 60 * 1000;
const PARAMETER_TYPES = new Set(["string", "integer", "boolean", "enum"]);

// ---------- results the scanner posts back ----------

export interface ScanResults {
  scanner_version?: string;
  // With no expected signer (a direct upload), the scanner verifies any keyless signature and reports every
  // identity it verified; applyScanResults compares them with the package's pinned signer.
  signature: { status: "pass" | "fail" | "absent"; identity?: string; issuer?: string; detail?: string; identities?: SignerIdentity[] };
  vulnerabilities: { critical: number; high: number; medium: number; low: number; fixable_critical: number; fixable_high: number } | null;
  secrets: { count: number; findings?: unknown[] };
  malware: { count: number; findings?: unknown[] };
  smoke: { status: "pass" | "fail" | "skipped"; exit_code?: number; duration_ms?: number; output_excerpt?: string; sample?: SmokeSample };
  sbom?: { packages: number };
}

export interface SignerIdentity {
  identity: string;
  issuer: string;
}

/** What the test input produced: a few entities (json, jsonl) or the start of stdout (csv, text). Shown on the tool page. */
export interface SmokeSample {
  output_format: string;
  entities?: unknown[];
  entity_count?: number;
  stdout?: string;
}

/** Caps a sample the scanner sent so a verbose tool cannot bloat the scan row or the tool page. */
export function trimSample(s: unknown): SmokeSample | undefined {
  if (!s || typeof s !== "object") return undefined;
  const x = s as SmokeSample;
  const out: SmokeSample = { output_format: typeof x.output_format === "string" ? x.output_format.slice(0, 10) : "json" };
  if (Array.isArray(x.entities) && x.entities.length) {
    out.entities = x.entities.slice(0, 5).filter((e) => e && typeof e === "object" && JSON.stringify(e).length <= 600);
    out.entity_count = Number.isInteger(x.entity_count) && (x.entity_count as number) >= out.entities.length ? x.entity_count : x.entities.length;
  }
  if (!out.entities?.length && typeof x.stdout === "string" && x.stdout.trim()) {
    delete out.entities;
    delete out.entity_count;
    out.stdout = x.stdout.slice(0, 2000);
  }
  return out.entities?.length || out.stdout ? out : undefined;
}

export type Verdict = { result: "pass" | "warn" } | { result: "fail"; code: string; message: string };

/**
 * The plan's verdict rules: a bad or dropped signature, suspected malware, embedded secrets or a
 * failed smoke test reject the release; fixable high/critical CVEs publish it with a warning.
 */
export function verdict(r: ScanResults, previouslySigned: boolean, direct = false): Verdict {
  if (r.signature.status === "fail") return { result: "fail", code: "signature_mismatch", message: `signature did not verify: ${r.signature.detail ?? "identity mismatch"}` };
  if (r.signature.status === "absent" && previouslySigned) {
    return {
      result: "fail", code: "signature_dropped",
      message: `earlier versions were signed but this one is not; ${direct ? "sign it with the same identity as before" : "sign it with the release workflow"}`,
    };
  }
  if (r.malware.count > 0) return { result: "fail", code: "malware_suspected", message: `${r.malware.count} malicious-code heuristic(s) matched; a reviewer will look at the report` };
  if (r.secrets.count > 0) return { result: "fail", code: "secrets_found", message: `${r.secrets.count} embedded secret(s) found in the artifact; rotate them and rebuild` };
  if (r.smoke.status === "fail") {
    return { result: "fail", code: "smoke_test_failed", message: `the test input exited with code ${r.smoke.exit_code ?? "?"}: ${(r.smoke.output_excerpt ?? "").slice(0, 200)}` };
  }
  const v = r.vulnerabilities;
  if (v && v.fixable_critical + v.fixable_high > 0) return { result: "warn" };
  return { result: "pass" };
}

// ---------- dispatch ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Who must have signed a release: the repository's own CI. The release templates sign on the default
 * branch before creating the tag, so a branch ref is accepted as well as this tag.
 */
export type ExpectedSigner = { identityRegexp: string; issuer: string };

export function expectedSigner(provider: "github" | "gitlab", repo: string, tag: string): ExpectedSigner {
  const ref = `@refs/(tags/${escapeRe(tag)}|heads/[^@]+)$`;
  return provider === "github"
    ? { identityRegexp: `^https://github\.com/${escapeRe(repo)}/\.github/workflows/[^@]+${ref}`, issuer: "https://token.actions.githubusercontent.com" }
    : { identityRegexp: `^https://gitlab\.com/${escapeRe(repo)}//[^@]+${ref}`, issuer: "https://gitlab.com" };
}

/**
 * Sends a version to the scanner. `signer` is who must have signed it (the source repository's CI), or null for a
 * direct upload, which any keyless signer may sign: the identities the scanner verifies are then checked against
 * the package's pinned signer when the results come back. `sourceRepo` ("github.com/owner/name") is where a wheel's
 * PyPI provenance must come from, empty when there is no repository.
 */
export async function dispatchScan(env: Env, opts: { versionId: string; signer: ExpectedSigner | null; sourceRepo: string; manifest: Manifest; upstream?: string }) {
  const { versionId, signer, sourceRepo, manifest: m, upstream } = opts;
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE versions SET scan_token_hash = ?, scan_token_expires_at = ?, expected_signer_regexp = ?, expected_signer_issuer = ? WHERE id = ?`,
  ).bind(await sha256Hex(token), now + SCAN_TOKEN_TTL, signer?.identityRegexp ?? null, signer?.issuer ?? null, versionId).run();

  // repository_dispatch allows at most 10 top-level keys in client_payload, so everything sits under "scan".
  const scan = {
    version_id: versionId,
    ref: `${m.namespace}/${m.name}@${m.version}`,
    source_repo: sourceRepo,
    // Community wrappers: the upstream project, whose own PyPI provenance is also accepted.
    ...(upstream ? { upstream_repo: upstream } : {}),
    kind: m.kind ?? "tool",
    runtime: m.runtime ?? null,
    test_input: (m.test as { input?: unknown } | undefined)?.input ?? null,
    // A tool that needs an API key can declare the exit code it gives without one; the scan has no secrets.
    expect_exit_code: (m.test as { expect_exit_code?: number } | undefined)?.expect_exit_code ?? 0,
    // Tools that declare egress get network access during the smoke test; everything else runs offline.
    network_egress: (m.network as { egress?: boolean } | undefined)?.egress === true,
    expected_signer: signer,
    callback_url: `${env.API_URL}/v1/internal/scans`,
    callback_token: token,
  };
  await dispatchOps(env, "otinstaller-scan", { scan });
  // Only a delivered dispatch counts; a failed one is retried by the queue (see processJob).
  await env.DB.prepare(`UPDATE versions SET scan_dispatched_at = ? WHERE id = ?`).bind(Date.now(), versionId).run();
}

/** Starts a workflow run in registry-ops (scans, backups, restore drills) with a repository_dispatch event. */
export async function dispatchOps(env: Env, eventType: string, clientPayload: Record<string, unknown>) {
  // repository_dispatch needs Contents: write on registry-ops. A token limited to that repository keeps the
  // App read-only on publishers' repositories; without one, the App's installation token is used.
  const opsToken = env.OPS_DISPATCH_TOKEN?.trim() || await github.installationToken(
    deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), Number(requireSecret(env, "OPS_INSTALLATION_ID")),
  );
  const res = await deps.fetch(`${github.GITHUB_API}/repos/${requireSecret(env, "OPS_REPO")}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opsToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "otinstaller-registry" },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (!res.ok) throw new github.HostError(`${eventType} dispatch failed: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
}

// ---------- outcome ----------

type VersionCtx = {
  id: string;
  tool_id: string;
  version: string;
  status: string;
  manifest_json: string;
  namespace_id: string;
  namespace: string;
  namespace_status: string;
  /** A community submission whose first release waits for a reviewer. */
  needs_first_review: number;
  name: string;
  kind: string;
  job_id: string | null;
  provider: "github" | "gitlab" | "direct" | null;
  repo: string | null;
  repo_id: string | null;
  installation_id: number | null;
  source_id: string | null;
  commit_sha: string | null;
};

export async function loadVersion(env: Env, where: string, ...binds: unknown[]): Promise<VersionCtx | null> {
  return env.DB.prepare(
    `SELECT v.id, v.tool_id, v.version, v.status, v.manifest_json, t.namespace_id, n.name AS namespace, n.status AS namespace_status,
       t.needs_first_review, t.name, t.kind, j.id AS job_id, j.provider, j.repo, j.repo_id, j.installation_id, j.source_id, j.commit_sha
     FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     LEFT JOIN publish_jobs j ON j.version_id = v.id
     WHERE ${where} ORDER BY j.created_at DESC LIMIT 1`,
  ).bind(...binds).first<VersionCtx>();
}

const refOf = (v: VersionCtx) => `${v.namespace}/${v.name}`;

/** How the author releases this version again: a direct upload is uploaded again, anything else re-tagged. */
export const retryHint = (v: { provider: string | null }) => (v.provider === "direct" ? "run `ot publish` again" : "push a new tag");

export async function commitStatus(env: Env, v: VersionCtx, state: CommitState, description: string) {
  if (!v.repo || !v.repo_id || !v.commit_sha) return;
  let host;
  if (v.provider === "gitlab") {
    const src = await env.DB.prepare(`SELECT connected_by FROM sources WHERE id = ?`).bind(v.source_id).first<{ connected_by: string | null }>();
    if (!src?.connected_by) return;
    host = gitlabRepo(env, v.repo_id, src.connected_by);
  } else {
    if (!v.installation_id) return;
    host = githubRepo(env, v.installation_id, v.repo, v.repo_id);
  }
  await host.setStatus(v.commit_sha, state, description, `${env.SITE_URL}/dashboard/publish/${v.job_id}`);
}

/** A signer identity without the git ref a CI identity ends in, so the same workflow signs every release alike. */
export function signerKey(identity: string): string {
  return identity.replace(/@refs\/[^@]*$/, "");
}

/**
 * A direct upload may be signed by anyone, so its package's first signer is pinned: later versions must carry a
 * signature from the same identity and issuer (ignoring the ref). Returns the results with the identity to record,
 * and a failed verdict when the first signed version has signatures from more than one signer.
 */
async function pinSigner(env: Env, v: VersionCtx, r: ScanResults): Promise<{ results: ScanResults; failed?: Verdict }> {
  if (r.signature.status !== "pass") return { results: r };
  const seen: SignerIdentity[] = r.signature.identities?.length
    ? r.signature.identities
    : r.signature.identity ? [{ identity: r.signature.identity, issuer: r.signature.issuer ?? "" }] : [];
  const names = [...new Set(seen.map((s) => signerKey(s.identity)))].join(", ") || "an identity the scanner could not read";
  const pin = await env.DB.prepare(
    `SELECT signer_identity, signer_issuer FROM versions WHERE tool_id = ? AND id != ? AND status != 'rejected' AND signer_identity IS NOT NULL
     ORDER BY created_at LIMIT 1`,
  ).bind(v.tool_id, v.id).first<{ signer_identity: string; signer_issuer: string | null }>();
  if (pin) {
    const match = seen.find((s) => signerKey(s.identity) === signerKey(pin.signer_identity) && s.issuer === (pin.signer_issuer ?? s.issuer));
    if (!match) {
      const detail = `signed by ${names}, not by ${signerKey(pin.signer_identity)}, which signed this package's earlier versions`;
      return { results: { ...r, signature: { ...r.signature, status: "fail", detail } } };
    }
    return { results: { ...r, signature: { ...r.signature, identity: match.identity, issuer: match.issuer } } };
  }
  if (new Set(seen.map((s) => `${signerKey(s.identity)}|${s.issuer}`)).size > 1) {
    return {
      results: r,
      failed: { result: "fail", code: "signature_ambiguous", message: `the first signed release has signatures from ${names}; it must have one signer, whom later versions are held to` },
    };
  }
  return { results: seen[0] ? { ...r, signature: { ...r.signature, identity: seen[0].identity, issuer: seen[0].issuer } } : r };
}

/** Applies scan results to a version: reject, publish, or hold for review. */
export async function applyScanResults(env: Env, v: VersionCtx, scanned: ScanResults): Promise<{ status: string; verdict: Verdict }> {
  const db = env.DB;
  const now = Date.now();
  const prevSigned = !!(await db.prepare(
    `SELECT 1 FROM versions WHERE tool_id = ? AND id != ? AND status IN ('published', 'yanked') AND signer_identity IS NOT NULL`,
  ).bind(v.tool_id, v.id).first());
  const direct = v.provider === "direct";
  const pinned = direct ? await pinSigner(env, v, scanned) : { results: scanned, failed: undefined };
  const r = pinned.results;
  const vd = pinned.failed ?? verdict(r, prevSigned, direct);

  const rows: [string, string, unknown][] = [
    ["signature", r.signature.status === "fail" ? "fail" : r.signature.status === "pass" ? "pass" : "warn", r.signature],
    ["vuln", r.vulnerabilities && r.vulnerabilities.fixable_critical + r.vulnerabilities.fixable_high > 0 ? "warn" : "pass", r.vulnerabilities],
    ["malware", r.malware.count + r.secrets.count > 0 ? "fail" : "pass", { malware: r.malware, secrets: r.secrets }],
    ["smoke", r.smoke.status === "fail" ? "fail" : r.smoke.status === "pass" ? "pass" : "warn", r.smoke],
  ];
  if (r.sbom) rows.push(["sbom", "pass", r.sbom]);
  const stmts = rows.map(([kind, result, summary]) =>
    db.prepare(`INSERT INTO scans (id, version_id, kind, result, summary_json, ran_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ulid(now), v.id, kind, result, JSON.stringify(summary), now),
  );
  // The callback token is single-use.
  stmts.push(db.prepare(`UPDATE versions SET scan_token_hash = NULL, scan_token_expires_at = NULL WHERE id = ?`).bind(v.id));

  if (vd.result === "fail") {
    stmts.push(
      db.prepare(`UPDATE versions SET status = 'rejected', scan_status = 'fail', rejected_reason = ? WHERE id = ?`).bind(vd.code, v.id),
      db.prepare(`UPDATE publish_jobs SET status = 'rejected', error_code = ?, error_detail = ?, updated_at = ? WHERE version_id = ?`).bind(vd.code, vd.message, now, v.id),
      audit(db, null, "system", "scan.rejected", "version", v.id, { code: vd.code }),
    );
    await db.batch(stmts);
    await commitStatus(env, v, "failure", `${vd.code}: ${vd.message}`);
    await sendEmail(env, {
      to: await ownerEmails(env, v.namespace_id), kind: "rejected", key: `rejected:${v.id}`,
      ...templates.rejected(env, refOf(v), v.version, vd.code, vd.message, retryHint(v)),
    });
    if (v.needs_first_review) await firstReleaseScanned(env, v.tool_id, "failed", `${vd.code}: ${vd.message}`);
    return { status: "rejected", verdict: vd };
  }

  const signed = r.signature.status === "pass";
  stmts.push(
    db.prepare(`UPDATE versions SET scan_status = ?, signer_identity = ?, signer_issuer = ? WHERE id = ?`)
      .bind(vd.result, signed ? r.signature.identity ?? null : null, signed ? r.signature.issuer ?? null : null, v.id),
    audit(db, null, "system", `scan.${vd.result}`, "version", v.id),
  );
  await db.batch(stmts);

  if (v.namespace_status === "active" && !v.needs_first_review) {
    // The scanner backs this version up itself, with the plan the callback answers with.
    await publishVersion(env, v.id, { backupInline: true });
    return { status: "published", verdict: vd };
  }
  await db.batch([
    db.prepare(`UPDATE versions SET status = 'awaiting_review' WHERE id = ?`).bind(v.id),
    db.prepare(`UPDATE publish_jobs SET status = 'awaiting_review', updated_at = ? WHERE version_id = ?`).bind(now, v.id),
  ]);
  if (v.needs_first_review) {
    // A community submission: a reviewer other than the submitter approves the first release (submissions.ts).
    await commitStatus(env, v, "pending", "Scans passed; a community reviewer looks at the first release");
    await firstReleaseScanned(env, v.tool_id, "in_review");
    return { status: "awaiting_review", verdict: vd };
  }
  await commitStatus(env, v, "pending", "Scans passed; new publisher awaiting review");
  await sendEmail(env, { to: await ownerEmails(env, v.namespace_id), kind: "in_review", key: `in_review:${v.id}`, ...templates.inReview(env, refOf(v), v.version) });
  return { status: "awaiting_review", verdict: vd };
}

const cmpSemver = (a: { semver_major: number; semver_minor: number; semver_patch: number }, b: typeof a) =>
  a.semver_major - b.semver_major || a.semver_minor - b.semver_minor || a.semver_patch - b.semver_patch;

type SemverRow = { id: string; semver_major: number; semver_minor: number; semver_patch: number; semver_pre: string };

/** `@latest`: the highest version that is not a prerelease, or the highest prerelease when there is nothing else. */
export function pickLatest<T extends SemverRow>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const stable = rows.filter((p) => p.semver_pre === "");
  const pool = stable.length ? stable : rows;
  return pool.reduce((a, b) => (cmpSemver(a, b) >= 0 ? a : b));
}

/** Search metadata follows the latest version: summary, categories, inputs and outputs, keys, and a guide's tools. */
export function latestMetadata(db: D1Database, toolId: string, kind: string, versionId: string, m: Manifest): D1PreparedStatement[] {
  const stmts = [
    db.prepare(`UPDATE tools SET summary = ?, categories = ?, tags = ?, readme_text = COALESCE((SELECT search_text FROM versions WHERE id = ?), readme_text) WHERE id = ?`)
      .bind(m.summary, JSON.stringify(m.categories), JSON.stringify(m.tags ?? []), versionId, toolId),
    // Tools without a test input are never health-checked; adding one makes them eligible again.
    db.prepare(`UPDATE tools SET health_status = CASE WHEN ? THEN (CASE WHEN health_status = 'not_checked' THEN 'unknown' ELSE health_status END) ELSE 'not_checked' END WHERE id = ?`)
      .bind(kind === "guide" || m.test ? 1 : 0, toolId),
    db.prepare(`DELETE FROM tool_io WHERE tool_id = ?`).bind(toolId),
    db.prepare(`DELETE FROM tool_secrets WHERE tool_id = ?`).bind(toolId),
  ];
  const ins = new Set<string>([...(m.inputs ?? []).map((i) => i.type).filter((t) => !PARAMETER_TYPES.has(t)), ...(m.topics ?? [])]);
  for (const t of ins) stmts.push(db.prepare(`INSERT INTO tool_io (tool_id, direction, type) VALUES (?, 'in', ?)`).bind(toolId, t));
  for (const t of new Set((m.outputs ?? []).map((o) => o.type))) stmts.push(db.prepare(`INSERT INTO tool_io (tool_id, direction, type) VALUES (?, 'out', ?)`).bind(toolId, t));
  for (const sec of m.secrets ?? []) stmts.push(db.prepare(`INSERT INTO tool_secrets (tool_id, name, required) VALUES (?, ?, ?)`).bind(toolId, sec.name, sec.required ? 1 : 0));
  if (kind === "guide") {
    stmts.push(db.prepare(`DELETE FROM tool_guides WHERE guide_id = ?`).bind(toolId));
    for (const rel of m.related_tools ?? []) {
      const [rns, rname] = rel.split("/");
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO tool_guides (guide_id, tool_id) SELECT ?, t.id FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
      ).bind(toolId, rns, rname));
    }
  }
  return stmts;
}

/** Makes a version public, updates the tool's latest version and its search metadata. */
export async function publishVersion(env: Env, versionId: string, opts: { backupInline?: boolean } = {}) {
  const db = env.DB;
  const now = Date.now();
  const v = await loadVersion(env, "v.id = ?", versionId);
  if (!v) throw new Error(`version ${versionId} not found`);
  const m = JSON.parse(v.manifest_json) as Manifest;

  const published = (await db.prepare(
    `SELECT id, semver_major, semver_minor, semver_patch, semver_pre FROM versions WHERE tool_id = ? AND (status = 'published' OR id = ?)`,
  ).bind(v.tool_id, versionId).all<SemverRow>()).results;
  const latest = pickLatest(published)!;
  const isLatest = latest.id === versionId;

  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE versions SET status = 'published', published_at = ? WHERE id = ?`).bind(now, versionId),
    db.prepare(`UPDATE publish_jobs SET status = 'published', updated_at = ? WHERE version_id = ?`).bind(now, versionId),
    db.prepare(`UPDATE tools SET latest_version_id = ?, updated_at = ? WHERE id = ?`).bind(latest.id, now, v.tool_id),
    audit(db, null, "system", "version.published", "version", versionId, { ref: refOf(v), version: v.version }),
  ];
  if (isLatest) stmts.push(...latestMetadata(db, v.tool_id, v.kind, versionId, m));
  await db.batch(stmts);
  // People following open broken or outdated issues are asked whether the new version fixes them.
  await announceVersion(env, v.tool_id, v.version).catch((e) => console.error("announcing the version on issues failed", e));
  // A reviewed community submission is out: its submitter becomes a maintainer.
  await firstReleasePublished(env, v.tool_id).catch((e) => console.error("finishing the submission failed", e));
  // Requests for this tool (its own repository, or the upstream a wrapper packages) are answered.
  await linkPublished(env, v.tool_id).catch((e) => console.error("linking tool requests failed", e));
  if (v.kind === "guide" && isLatest) await updateLinkHealth(env, v.tool_id);
  const scan = await db.prepare(`SELECT scan_status FROM versions WHERE id = ?`).bind(versionId).first<{ scan_status: string }>();
  await commitStatus(env, v, "success", `Published ${refOf(v)}@${v.version}`);
  // Backups never hold up publishing: a version the scanner did not just back up gets its own backup job.
  if (!opts.backupInline) await env.PUBLISH_QUEUE.send({ backupVersionId: versionId }).catch((e) => console.error("queueing the backup failed", e));
  await sendEmail(env, { to: await ownerEmails(env, v.namespace_id), kind: "published", key: `published:${versionId}`, ...templates.published(env, refOf(v), v.version, scan?.scan_status === "warn") });
}

/** Scans that never called back are rejected so the author can re-tag. */
export async function expireStaleScans(env: Env, now = Date.now()) {
  const stale = await env.DB.prepare(
    `SELECT id FROM versions WHERE status = 'scanning' AND scan_token_expires_at IS NOT NULL AND scan_token_expires_at < ?`,
  ).bind(now).all<{ id: string }>();
  for (const { id } of stale.results) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE versions SET status = 'rejected', rejected_reason = 'scan_timeout', scan_token_hash = NULL WHERE id = ?`).bind(id),
      env.DB.prepare(
        `UPDATE publish_jobs SET status = 'error', error_code = 'scan_timeout', updated_at = ?,
           error_detail = 'the security scan did not report back within an hour; ' || CASE WHEN provider = 'direct' THEN 'run ot publish again' ELSE 'push the tag again' END
         WHERE version_id = ?`,
      ).bind(now, id),
    ]);
  }
  return stale.results.length;
}
