// Queue consumer: validates a tagged release and records it as a version.
// Valid releases move to `scanning` (scans arrive in week 5); invalid ones are `rejected`, and the
// author sees why as a failed commit status on the tagged commit.
import { deps, requireSecret, type Env } from "./env";
import { ulid } from "./lib/crypto";
import { parseManifest, referencedFiles, semverParts, type Manifest, type Problem } from "./lib/manifest";
import * as github from "./hosts/github";
import { checkImage, checkWheel } from "./hosts/artifacts";
import { audit } from "./routes/auth";
import { dispatchScan } from "./scans";
import { ownerEmails, sendEmail, templates } from "./notify";

export const MANIFEST_FILE = "otinstaller.yaml";

type Job = {
  id: string;
  repo: string;
  repo_id: string;
  tag: string;
  installation_id: number;
  status: string;
  attempts: number;
};

type Outcome = { status: "scanning" | "rejected"; problems: Problem[]; versionId?: string };

export async function processJob(env: Env, jobId: string): Promise<Outcome | null> {
  const db = env.DB;
  const job = await db.prepare(`SELECT id, repo, repo_id, tag, installation_id, status, attempts FROM publish_jobs WHERE id = ?`).bind(jobId).first<Job>();
  if (!job) return null;
  if (job.status === "scanning") {
    // Validation finished but the scan dispatch failed last time: dispatch again.
    const v = await db.prepare(
      `SELECT v.id, v.manifest_json FROM publish_jobs j JOIN versions v ON v.id = j.version_id WHERE j.id = ? AND v.status = 'scanning' AND v.scan_dispatched_at IS NULL`,
    ).bind(jobId).first<{ id: string; manifest_json: string }>();
    if (v) await dispatchScan(env, { versionId: v.id, repo: job.repo, tag: job.tag, manifest: JSON.parse(v.manifest_json) });
    return null;
  }
  if (!["queued", "validating"].includes(job.status)) return null; // already handled
  await db.prepare(`UPDATE publish_jobs SET status = 'validating', attempts = attempts + 1, updated_at = ? WHERE id = ?`).bind(Date.now(), jobId).run();

  const f = deps.fetch;
  const token = await github.installationToken(f, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), job.installation_id);
  const sha = await github.tagCommit(f, token, job.repo, job.tag);
  await db.prepare(`UPDATE publish_jobs SET commit_sha = ? WHERE id = ?`).bind(sha, jobId).run();
  const target = `${env.SITE_URL}/dashboard/publish/${jobId}`;
  await github.setCommitStatus(f, token, job.repo, sha, "pending", "Validating otinstaller.yaml", target);

  const ns = await db.prepare(
    `SELECT n.id, n.name, n.status FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE i.github_installation_id = ?`,
  ).bind(job.installation_id).first<{ id: string; name: string; status: string }>();
  if (!ns) throw new Error(`installation ${job.installation_id} has no namespace`);

  const text = await github.fileAt(f, token, job.repo, MANIFEST_FILE, sha);
  let manifest: Manifest | undefined;
  let problems: Problem[];
  let readme = "";
  if (text === null) {
    problems = [{ code: "manifest_file_missing", path: "/", message: `${MANIFEST_FILE} was not found at ${job.tag}`, hint: "run `ot init` and commit the file" }];
  } else {
    ({ manifest, problems } = parseManifest(text));
  }
  if (manifest && problems.length === 0) {
    problems = await releaseProblems(env, manifest, job, ns.name, ns.status);
    if (problems.length === 0) {
      for (const file of referencedFiles(manifest)) {
        const content = await github.fileAt(f, token, job.repo, file.path, sha);
        if (content === null) problems.push({ code: "manifest_file_missing", path: file.field, message: `${file.path} does not exist at ${job.tag}` });
        else if (file.field === "/readme") readme = content;
      }
    }
    if (problems.length === 0) problems = await artifactProblems(manifest);
  }

  const outcome = await record(env, job, sha, ns, manifest, problems, readme);
  if (outcome.status === "scanning") {
    await dispatchScan(env, { versionId: outcome.versionId!, repo: job.repo, tag: job.tag, manifest: manifest! });
  } else if (manifest && outcome.versionId) {
    const first = problems[0]!;
    await sendEmail(env, { to: await ownerEmails(env, ns.id), kind: "rejected", key: `rejected:${job.id}`, ...templates.rejected(env, `${manifest.namespace}/${manifest.name}`, manifest.version, first.code, first.message) });
  }
  const first = problems[0];
  await github.setCommitStatus(
    f, token, job.repo, sha,
    outcome.status === "rejected" ? "failure" : "pending",
    outcome.status === "rejected" ? `${first!.code}: ${first!.message}` : "Valid; security scans running",
    target,
  );
  return outcome;
}

async function releaseProblems(env: Env, m: Manifest, job: Job, namespace: string, nsStatus: string): Promise<Problem[]> {
  const ps: Problem[] = [];
  if (nsStatus === "rejected" || nsStatus === "suspended") {
    ps.push({ code: "namespace_not_allowed", path: "/namespace", message: `namespace ${namespace} is ${nsStatus} and cannot publish`, hint: "contact abuse@otinstaller.com" });
    return ps;
  }
  if (job.tag.replace(/^v/, "") !== m.version) {
    ps.push({ code: "manifest_tag_mismatch", path: "/version", message: `tag ${job.tag} does not match version ${m.version}`, hint: "tag releases as v<version>" });
  }
  if (m.namespace !== namespace) {
    ps.push({ code: "manifest_namespace_mismatch", path: "/namespace", message: `this repository publishes to "${namespace}", not "${m.namespace}"` });
  }
  const exists = await env.DB.prepare(
    `SELECT 1 FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE n.name = ? AND t.name = ? AND v.version = ? AND v.status != 'rejected'`,
  ).bind(namespace, m.name, m.version).first();
  if (exists) ps.push({ code: "manifest_version_exists", path: "/version", message: `${m.name} ${m.version} is already published; versions are immutable`, hint: "bump the version" });
  // A package's name belongs to the repository that first published it.
  const owner = await env.DB.prepare(
    `SELECT t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
  ).bind(namespace, m.name).first<{ repo_url: string | null }>();
  if (owner?.repo_url && owner.repo_url !== `https://github.com/${job.repo}`) {
    ps.push({ code: "manifest_name_taken", path: "/name", message: `${namespace}/${m.name} is published from ${owner.repo_url}` });
  }
  return ps;
}

async function artifactProblems(m: Manifest): Promise<Problem[]> {
  const rt = m.runtime;
  if (!rt) return [];
  if (rt.kind === "docker") return checkImage(deps.fetch, rt.image!);
  return checkWheel(deps.fetch, rt.package!, rt.package_version!, rt.wheel_sha256!);
}

/** Writes the tool, version and job outcome in one batch. */
async function record(env: Env, job: Job, sha: string, ns: { id: string }, m: Manifest | undefined, problems: Problem[], readme: string): Promise<Outcome> {
  const db = env.DB;
  const now = Date.now();
  const status = problems.length ? "rejected" : "scanning";
  const stmts: D1PreparedStatement[] = [];
  let versionId: string | undefined;
  let toolId: string | null = null;

  // A version row needs a well-formed name and version that belong to this namespace.
  const identifiable = m && !problems.some((p) => ["manifest_namespace_mismatch", "manifest_version_exists", "manifest_name_taken"].includes(p.code));
  if (m && identifiable) {
    const tool = await db.prepare(`SELECT id FROM tools WHERE namespace_id = ? AND name = ?`).bind(ns.id, m.name).first<{ id: string }>();
    toolId = tool?.id ?? ulid(now);
    if (!tool) {
      stmts.push(db.prepare(
        `INSERT INTO tools (id, namespace_id, kind, name, summary, categories, tags, repo_url, readme_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(toolId, ns.id, m.kind ?? "tool", m.name, m.summary, JSON.stringify(m.categories), JSON.stringify(m.tags ?? []), `https://github.com/${job.repo}`, readme.slice(0, 20000), now, now));
    }
    const sv = semverParts(m.version);
    // Re-tagging a version that was rejected reuses its row.
    const prior = tool ? await db.prepare(`SELECT id FROM versions WHERE tool_id = ? AND version = ?`).bind(toolId, m.version).first<{ id: string }>() : null;
    versionId = prior?.id ?? ulid(now);
    stmts.push(db.prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, artifact_ref, git_sha, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool_id, version) DO UPDATE SET manifest_json = excluded.manifest_json, git_sha = excluded.git_sha, status = excluded.status,
         scan_status = 'pending', rejected_reason = NULL, created_at = excluded.created_at`,
    ).bind(versionId, toolId, m.version, sv.major, sv.minor, sv.patch, sv.pre, JSON.stringify(m), m.runtime?.kind ?? null,
      m.runtime?.image ?? (m.runtime?.wheel_sha256 ? `sha256:${m.runtime.wheel_sha256}` : null), sha, status, now));
  }
  stmts.push(
    db.prepare(`UPDATE publish_jobs SET status = ?, tool_id = ?, version_id = ?, error_code = ?, error_detail = ?, problems_json = ?, updated_at = ? WHERE id = ?`)
      .bind(status, toolId, versionId ?? null, problems[0]?.code ?? null, problems[0]?.message ?? null, JSON.stringify(problems), now, job.id),
    audit(db, null, "system", `publish.${status}`, "publish_job", job.id, { repo: job.repo, tag: job.tag, codes: problems.map((p) => p.code) }),
  );
  await db.batch(stmts);
  return { status, problems, versionId };
}

/** Marks a job that kept failing on transient errors, so it shows up in the stuck-job alert. */
export async function failJob(env: Env, jobId: string, error: string) {
  await env.DB.prepare(`UPDATE publish_jobs SET status = 'error', error_code = 'internal_error', error_detail = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'validating')`)
    .bind(error.slice(0, 500), Date.now(), jobId).run();
}

export async function handleBatch(batch: MessageBatch<{ jobId: string }>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await processJob(env, msg.body.jobId);
      msg.ack();
    } catch (e) {
      const transient = !(e instanceof github.HostError) || e.transient;
      if (transient && msg.attempts < 5) {
        msg.retry({ delaySeconds: 30 * msg.attempts });
      } else {
        await failJob(env, msg.body.jobId, (e as Error).message);
        msg.ack();
      }
    }
  }
}
