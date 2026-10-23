// Queue consumer: validates a release and records it as a version. A release is a tag on GitHub or GitLab, or an
// upload from `ot publish` (a bundle job: direct.ts), whose files are read from R2 instead of a commit.
// Valid releases move to `scanning` (a security scan for tools, content checks for guides); invalid ones
// are `rejected`, and the author sees why as a failed commit status on the tagged commit (for an upload, in
// `ot publish` and on the dashboard). The same queue runs bulk-import detection, guide content checks and nightly
// link checks.
import { syncProfile } from "./profiles";
import { deps, type Env, type PublishMessage } from "./env";
import { ulid } from "./lib/crypto";
import { parseManifest, referencedFiles, semverParts, type Manifest, type Problem } from "./lib/manifest";
import * as github from "./hosts/github";
import { githubRepo, gitlabRepo, repoUrl, type RepoHost } from "./hosts/repo";
import { checkImage, checkWheel } from "./hosts/artifacts";
import { audit } from "./routes/auth";
import { commitStatus, dispatchScan, expectedSigner, loadVersion, publishVersion, retryHint } from "./scans";
import { backupVersion, hostedImage, sweepMirrorRepo } from "./backups";
import { imageExists, imagePlatforms } from "./mirror/registry";
import { copyImages, queueContentChecks, rawFileUrl, recheckLinks, relatedToolProblems, renderRelease, runContentChecks, storeContent, type RenderedRelease } from "./guides";
import { ownerEmails, sendEmail, templates } from "./notify";
import { COMMUNITY_NAMESPACE, detectQueued, failImport, heldManifestFor, parseRepoRef } from "./imports";
import { bundleHost, deleteBundle } from "./direct";

export const MANIFEST_FILE = "otinstaller.yaml";

type Job = {
  id: string;
  // "direct" for an upload with no repository behind it.
  provider: "github" | "gitlab" | "direct";
  repo: string; // owner/name on GitHub, group/project path on GitLab, <namespace>/<name> for a direct upload
  repo_id: string;
  tag: string;
  installation_id: number | null;
  source_id: string | null;
  status: string;
  attempts: number;
  // Bundle jobs (uploads) name their namespace and keep their files in R2; tag jobs have neither.
  namespace_id: string | null;
  bundle_key: string | null;
  commit_sha: string | null;
  submitted_by: string | null;
};

const JOB_COLUMNS = `id, provider, repo, repo_id, tag, installation_id, source_id, status, attempts, namespace_id, bundle_key, commit_sha, submitted_by`;

type Namespace = { id: string; name: string; status: string };

/** The repository host for a job (or its upload), and the namespace it publishes into. */
async function jobContext(env: Env, job: Job): Promise<{ host: RepoHost; ns: Namespace }> {
  if (job.bundle_key) {
    const ns = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE id = ?`).bind(job.namespace_id).first<Namespace>();
    if (!ns) throw new Error(`job ${job.id} has no namespace`);
    return { host: bundleHost(env, job.bundle_key, job.provider), ns };
  }
  if (job.provider === "github") {
    const ns = await env.DB.prepare(
      `SELECT n.id, n.name, n.status FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE i.github_installation_id = ?`,
    ).bind(job.installation_id).first<Namespace>();
    if (!ns) throw new Error(`installation ${job.installation_id} has no namespace`);
    return { host: githubRepo(env, job.installation_id!, job.repo, job.repo_id), ns };
  }
  const src = await env.DB.prepare(
    `SELECT s.connected_by, n.id, n.name, n.status FROM sources s JOIN namespaces n ON n.id = s.namespace_id WHERE s.id = ?`,
  ).bind(job.source_id).first<Namespace & { connected_by: string }>();
  if (!src) throw new Error(`job ${job.id} has no connected GitLab project`);
  return { host: gitlabRepo(env, job.repo_id, src.connected_by), ns: { id: src.id, name: src.name, status: src.status } };
}

type Outcome = { status: "scanning" | "rejected"; problems: Problem[]; versionId?: string };

/** Where links into the repository point on a job's pages. An upload has no repository, so they stay plain text. */
function fileUrlFor(job: Job, sha: string): (path: string) => string | null {
  if (job.provider === "direct") return () => null;
  const provider = job.provider;
  return (p) => rawFileUrl(provider, job.repo, sha || job.tag, p);
}

/** Reads the files a valid manifest refers to and renders its README and pages, with their images copied to the registry. */
async function prepareContent(env: Env, job: Job, host: RepoHost, sha: string, manifest: Manifest): Promise<{ problems: Problem[]; readme: string; content?: RenderedRelease }> {
  const problems: Problem[] = [];
  const files = new Map<string, string>();
  const where = job.bundle_key ? "in the upload" : `at ${job.tag}`;
  for (const file of referencedFiles(manifest)) {
    const text = await host.fileAt(file.path, sha);
    if (text === null) problems.push({ code: "manifest_file_missing", path: file.field, message: `${file.path} does not exist ${where}` });
    else files.set(file.path, text);
  }
  const readme = manifest.readme ? (files.get(manifest.readme) ?? "") : "";
  if (problems.length) return { problems, readme };
  const fileUrl = fileUrlFor(job, sha);
  const first = renderRelease(env, manifest, files, fileUrl);
  if (first.problems.length) return { problems: first.problems, readme };
  // Render again with the images' registry URLs once they are copied.
  const copied = await copyImages(env, host, sha, first);
  if (copied.problems.length) return { problems: copied.problems, readme };
  return { problems: [], readme, content: { ...renderRelease(env, manifest, files, fileUrl, copied.assets), images: copied.images } };
}

export async function processJob(env: Env, jobId: string): Promise<Outcome | null> {
  const db = env.DB;
  const job = await db.prepare(`SELECT ${JOB_COLUMNS} FROM publish_jobs WHERE id = ?`).bind(jobId).first<Job>();
  if (!job) return null;
  if (job.status === "scanning") {
    // Validation finished but storing the pages or dispatching the checks failed last time: finish that.
    const v = await db.prepare(
      `SELECT v.id, v.manifest_json, v.search_text IS NULL AS unstored FROM publish_jobs j JOIN versions v ON v.id = j.version_id
       WHERE j.id = ? AND v.status = 'scanning' AND v.scan_dispatched_at IS NULL`,
    ).bind(jobId).first<{ id: string; manifest_json: string; unstored: number }>();
    if (v) {
      const m = JSON.parse(v.manifest_json) as Manifest;
      if (v.unstored) {
        const { host } = await jobContext(env, job);
        const prepared = await prepareContent(env, job, host, job.commit_sha ?? "", m);
        if (prepared.content) await storeContent(env, v.id, m, prepared.content);
      }
      await startChecks(env, v.id, job, m);
      await deleteBundle(env, job.bundle_key);
    }
    return null;
  }
  if (!["queued", "validating"].includes(job.status)) return null; // already handled
  await db.prepare(`UPDATE publish_jobs SET status = 'validating', attempts = attempts + 1, updated_at = ? WHERE id = ?`).bind(Date.now(), jobId).run();

  const { host, ns } = await jobContext(env, job);
  // A tag is resolved to its commit; an upload has none to resolve.
  const sha = job.bundle_key ? (job.commit_sha ?? "") : await host.tagCommit(job.tag);
  if (!job.bundle_key) await db.prepare(`UPDATE publish_jobs SET commit_sha = ? WHERE id = ?`).bind(sha, jobId).run();
  const target = `${env.SITE_URL}/dashboard/publish/${jobId}`;
  await host.setStatus(sha, "pending", "Validating otinstaller.yaml", target);

  const text = await host.fileAt(MANIFEST_FILE, sha);
  // A manifest in the repository always wins; otherwise the registry may hold one for this package. Uploads carry their own.
  const held = job.bundle_key ? null : await env.DB.prepare(`SELECT manifest_mode, registry_manifest_json FROM sources WHERE provider = ? AND project_id = ?`)
    .bind(job.provider, job.repo_id).first<{ manifest_mode: string; registry_manifest_json: string | null }>();
  const fromRegistry = text === null && held?.manifest_mode === "registry" && !!held.registry_manifest_json;
  let manifest: Manifest | undefined;
  let problems: Problem[];
  let readme = "";
  let content: RenderedRelease | undefined;
  if (fromRegistry) {
    ({ manifest, problems } = await heldManifestFor(held!.registry_manifest_json!, job.tag));
  } else if (text === null) {
    problems = [{ code: "manifest_file_missing", path: "/", message: `${MANIFEST_FILE} was not found ${job.bundle_key ? "in the upload" : `at ${job.tag}`}`, hint: "run `ot init` and commit the file" }];
  } else {
    ({ manifest, problems } = parseManifest(text));
  }
  if (manifest && problems.length === 0) {
    problems = await releaseProblems(env, manifest, job, ns.name, ns.status);
    if (problems.length === 0) ({ problems, readme, content } = await prepareContent(env, job, host, sha, manifest));
    if (problems.length === 0) problems = manifest.kind === "guide" ? await relatedToolProblems(env, manifest) : await artifactProblems(env, manifest);
  }

  const outcome = await record(env, job, sha, ns, manifest, problems, readme);
  if (outcome.status === "scanning" && held?.manifest_mode === "registry" && !fromRegistry) {
    // The manifest moved into the repository: the registry-held label and ranking penalty go away.
    await db.batch([
      db.prepare(`UPDATE sources SET manifest_mode = 'repo', registry_manifest_json = NULL WHERE provider = ? AND project_id = ?`).bind(job.provider, job.repo_id),
      audit(db, null, "system", "source.manifest_moved_to_repo", "publish_job", job.id),
    ]);
  }
  if (outcome.status === "scanning") {
    await storeContent(env, outcome.versionId!, manifest!, content!);
    // The status moves on before dispatch, so a dispatch that keeps failing never leaves "Validating" behind.
    await host.setStatus(sha, "pending", manifest!.kind === "guide" ? "Valid; content checks running" : "Valid; security scans running", target);
    await startChecks(env, outcome.versionId!, job, manifest!);
    await deleteBundle(env, job.bundle_key);
    return outcome;
  }
  const first = outcome.problems[0]!;
  if (manifest && outcome.versionId) {
    await sendEmail(env, {
      to: await ownerEmails(env, ns.id), kind: "rejected", key: `rejected:${job.id}`,
      ...templates.rejected(env, `${manifest.namespace}/${manifest.name}`, manifest.version, first.code, first.message, retryHint(job)),
    });
  }
  await host.setStatus(sha, "failure", `${first.code}: ${first.message}`, target);
  await deleteBundle(env, job.bundle_key);
  return outcome;
}

/** Tools go to the security scanner; guides get content checks in the Worker. */
async function startChecks(env: Env, versionId: string, job: Job, m: Manifest) {
  if (m.kind === "guide") return queueContentChecks(env, versionId);
  // An upload with no repository has no CI to have signed it: any signer passes, and the first is pinned (scans.ts).
  await dispatchScan(env, {
    versionId, manifest: m, upstream: upstreamOf(job, m),
    signer: job.provider === "direct" ? null : expectedSigner(job.provider, job.repo, job.tag),
    sourceRepo: job.provider === "direct" ? "" : `${job.provider}.com/${job.repo}`,
  });
}

/**
 * A community wrapper repackages another project's release, so that release (a PyPI wheel, say) carries the
 * upstream repository's provenance, not the wrapper's. The scanner accepts either.
 */
export function upstreamOf(job: { repo: string }, m: Manifest): string | undefined {
  if (m.namespace !== COMMUNITY_NAMESPACE || typeof m.homepage !== "string") return undefined;
  const ref = parseRepoRef(m.homepage);
  if (!ref || ref.path.toLowerCase() === job.repo.toLowerCase()) return undefined;
  return `${ref.provider}.com/${ref.path}`;
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
    ps.push({ code: "manifest_namespace_mismatch", path: "/namespace", message: `this ${job.bundle_key ? "upload" : "repository"} publishes to "${namespace}", not "${m.namespace}"` });
  }
  const exists = await env.DB.prepare(
    `SELECT 1 FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
     WHERE n.name = ? AND t.name = ? AND v.version = ? AND v.status != 'rejected'`,
  ).bind(namespace, m.name, m.version).first();
  if (exists) ps.push({ code: "manifest_version_exists", path: "/version", message: `${m.name} ${m.version} is already published; versions are immutable`, hint: "bump the version" });
  // A package's name belongs to the repository that first published it. A package without one (uploaded directly)
  // belongs to its namespace, until a repository in it releases the package and claims it (record).
  const owner = await env.DB.prepare(
    `SELECT t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
  ).bind(namespace, m.name).first<{ repo_url: string | null }>();
  if (owner?.repo_url && (job.provider === "direct" || owner.repo_url !== repoUrl(job.provider, job.repo))) {
    ps.push({
      code: "manifest_name_taken", path: "/name", message: `${namespace}/${m.name} is published from ${owner.repo_url}`,
      hint: job.provider === "direct" ? "release it from that repository; uploads are for packages without one" : undefined,
    });
  }
  return ps;
}

async function artifactProblems(env: Env, m: Manifest): Promise<Problem[]> {
  const rt = m.runtime;
  if (!rt) return [];
  if (rt.kind === "pipx") return checkWheel(deps.fetch, rt.package!, rt.package_version!, rt.wheel_sha256!);
  const hosted = hostedImage(env, rt.image);
  return hosted ? hostedImageProblems(env, m, hosted) : checkImage(deps.fetch, rt.image!);
}

/**
 * An image on the registry's own mirror is read through its bucket (a pushed image isn't public until it is
 * published), and must be this package's: <mirror>/<namespace>/<name>, so nobody can publish another package's image.
 */
async function hostedImageProblems(env: Env, m: Manifest, hosted: { repo: string; digest: string }): Promise<Problem[]> {
  const image = m.runtime!.image!;
  if (hosted.repo !== `${m.namespace}/${m.name}`) {
    return [{ code: "artifact_image_foreign", path: "/runtime/image", message: `${image} is not ${m.namespace}/${m.name}'s image on the mirror`, hint: "push the image with `ot publish --image`, which names it after the package" }];
  }
  if (!(await imageExists(env.MIRROR, hosted.repo, hosted.digest))) {
    return [{ code: "artifact_image_not_found", path: "/runtime/image", message: `${image} was not pushed to the mirror`, hint: "push it with `ot publish --image`" }];
  }
  const platforms = await imagePlatforms(env.MIRROR, hosted.repo, hosted.digest);
  if (platforms && !platforms.includes("linux/amd64")) return [{ code: "artifact_platform_missing", path: "/runtime/image", message: `${image} has no linux/amd64 variant` }];
  return [];
}

/** Writes the tool, version and job outcome in one batch. */
async function record(env: Env, job: Job, sha: string, ns: Namespace, m: Manifest | undefined, problems: Problem[], readme: string): Promise<Outcome> {
  const db = env.DB;
  const now = Date.now();
  const status = problems.length ? "rejected" : "scanning";
  const stmts: D1PreparedStatement[] = [];
  let versionId: string | undefined;
  let toolId: string | null = null;
  let versionStmt = -1;
  const repo = job.provider === "direct" ? null : repoUrl(job.provider, job.repo);

  // A version row needs a well-formed name and version that belong to this namespace.
  const identifiable = m && !problems.some((p) => ["manifest_namespace_mismatch", "manifest_version_exists", "manifest_name_taken"].includes(p.code));
  if (m && identifiable) {
    const tool = await db.prepare(`SELECT id FROM tools WHERE namespace_id = ? AND name = ?`).bind(ns.id, m.name).first<{ id: string }>();
    toolId = tool?.id ?? ulid(now);
    if (!tool) {
      stmts.push(db.prepare(
        `INSERT INTO tools (id, namespace_id, kind, name, summary, categories, tags, repo_url, readme_text, community_packaged, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(toolId, ns.id, m.kind ?? "tool", m.name, m.summary, JSON.stringify(m.categories), JSON.stringify(m.tags ?? []), repo, readme.slice(0, 20000),
        // A package in the community namespace whose homepage is another repository wraps someone else's tool and is
        // labelled so; the namespace's own tools (homepage is the source repository, or none) are first-party.
        upstreamOf(job, m) ? 1 : 0, now, now));
    } else if (repo) {
      // The first repository to release a package that was uploaded directly claims its name from now on.
      stmts.push(db.prepare(`UPDATE tools SET repo_url = ? WHERE id = ? AND repo_url IS NULL`).bind(repo, toolId));
    }
    // Link the package to its source repository, which sync keeps up to date from now on. Uploads have no source to sync.
    if (!job.bundle_key && job.provider === "github") {
      stmts.push(db.prepare(
        `INSERT INTO sources (id, tool_id, namespace_id, provider, project_id, path, url, installation_id, created_at)
         VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?)
         ON CONFLICT (provider, project_id) DO UPDATE SET tool_id = COALESCE(sources.tool_id, excluded.tool_id),
           path = excluded.path, url = excluded.url, installation_id = excluded.installation_id`,
      ).bind(ulid(now), toolId, ns.id, job.repo_id, job.repo, repoUrl("github", job.repo), job.installation_id, now));
    } else if (!job.bundle_key) {
      stmts.push(db.prepare(`UPDATE sources SET tool_id = COALESCE(tool_id, ?) WHERE id = ?`).bind(toolId, job.source_id));
    }
    const sv = semverParts(m.version);
    // Re-tagging a version that was rejected reuses its row. Only a rejected row is ever reused: a release of the
    // same version still being checked (two uploads at once) is left alone, and this one stops below.
    const prior = tool ? await db.prepare(`SELECT id FROM versions WHERE tool_id = ? AND version = ?`).bind(toolId, m.version).first<{ id: string }>() : null;
    versionId = prior?.id ?? ulid(now);
    versionStmt = stmts.length;
    stmts.push(db.prepare(
      `INSERT INTO versions (id, tool_id, version, semver_major, semver_minor, semver_patch, semver_pre, manifest_json, runtime_kind, artifact_ref, git_sha, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool_id, version) DO UPDATE SET manifest_json = excluded.manifest_json, git_sha = excluded.git_sha, status = excluded.status,
         scan_status = 'pending', rejected_reason = NULL, search_text = NULL, created_at = excluded.created_at
       WHERE versions.status = 'rejected'`,
    ).bind(versionId, toolId, m.version, sv.major, sv.minor, sv.patch, sv.pre, JSON.stringify(m), m.runtime?.kind ?? null,
      m.runtime?.image ?? (m.runtime?.wheel_sha256 ? `sha256:${m.runtime.wheel_sha256}` : null), sha || null, status, now));
  }
  stmts.push(
    db.prepare(`UPDATE publish_jobs SET status = ?, tool_id = ?, version_id = ?, error_code = ?, error_detail = ?, problems_json = ?, updated_at = ? WHERE id = ?`)
      .bind(status, toolId, versionId ?? null, problems[0]?.code ?? null, problems[0]?.message ?? null, JSON.stringify(problems), now, job.id),
    audit(db, job.submitted_by, job.submitted_by ? "user" : "system", `publish.${status}`, "publish_job", job.id, { repo: job.repo, tag: job.tag, codes: problems.map((p) => p.code) }),
  );
  const results = await db.batch(stmts);
  if (versionStmt >= 0 && !results[versionStmt]?.meta.changes) {
    const taken: Problem = { code: "manifest_version_exists", path: "/version", message: `${m!.name} ${m!.version} is already being published; versions are immutable`, hint: "bump the version" };
    await db.prepare(`UPDATE publish_jobs SET status = 'rejected', version_id = NULL, error_code = ?, error_detail = ?, problems_json = ?, updated_at = ? WHERE id = ?`)
      .bind(taken.code, taken.message, JSON.stringify([taken]), Date.now(), job.id).run();
    return { status: "rejected", problems: [taken] };
  }
  return { status, problems, versionId };
}

/**
 * Marks a job that kept failing on transient errors, so it shows up in the stuck-job alert. That includes
 * a valid release whose scan never got dispatched: its version is closed so the author can push the tag
 * again, and the commit status says so instead of staying pending.
 */
export async function failJob(env: Env, jobId: string, error: string) {
  const db = env.DB;
  const now = Date.now();
  const job = await db.prepare(
    `SELECT j.status, j.version_id, j.bundle_key, v.scan_dispatched_at FROM publish_jobs j LEFT JOIN versions v ON v.id = j.version_id WHERE j.id = ?`,
  ).bind(jobId).first<{ status: string; version_id: string | null; bundle_key: string | null; scan_dispatched_at: number | null }>();
  if (!job) return;
  const undispatched = job.status === "scanning" && job.version_id !== null && job.scan_dispatched_at === null;
  if (!["queued", "validating"].includes(job.status) && !undispatched) return;
  await deleteBundle(env, job.bundle_key).catch((e) => console.error("deleting the upload failed", e));
  const stmts = [
    db.prepare(`UPDATE publish_jobs SET status = 'error', error_code = 'internal_error', error_detail = ?, updated_at = ? WHERE id = ?`).bind(error.slice(0, 500), now, jobId),
  ];
  if (undispatched) {
    stmts.push(db.prepare(`UPDATE versions SET status = 'rejected', rejected_reason = 'internal_error' WHERE id = ? AND status = 'scanning'`).bind(job.version_id));
  }
  await db.batch(stmts);
  const v = job.version_id ? await loadVersion(env, "v.id = ?", job.version_id) : null;
  if (v) await commitStatus(env, v, "error", "The registry could not start the checks; push the tag again").catch(() => {});
}

/** Publishes a release approved with its namespace, unless something else got to it first. */
export async function publishApproved(env: Env, versionId: string) {
  const v = await env.DB.prepare(
    `SELECT v.status, n.status AS namespace_status FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id WHERE v.id = ?`,
  ).bind(versionId).first<{ status: string; namespace_status: string }>();
  if (v?.status === "awaiting_review" && v.namespace_status === "active") await publishVersion(env, versionId);
}

export async function handleBatch(batch: MessageBatch<PublishMessage>, env: Env) {
  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      if ("importId" in body) await detectQueued(env, body.importId);
      else if ("checkVersionId" in body) await runContentChecks(env, body.checkVersionId, body.attempt ?? 0);
      else if ("linkCheckToolId" in body) await recheckLinks(env, body.linkCheckToolId);
      else if ("publishVersionId" in body) await publishApproved(env, body.publishVersionId);
      else if ("backupVersionId" in body) await backupVersion(env, body.backupVersionId);
      else if ("profileNamespaceId" in body) await syncProfile(env, body.profileNamespaceId);
      else if ("mirrorSweepRepo" in body) await sweepMirrorRepo(env, body.mirrorSweepRepo);
      else await processJob(env, body.jobId);
      msg.ack();
    } catch (e) {
      const transient = !(e instanceof github.HostError) || e.transient;
      if (transient && msg.attempts < 5) {
        msg.retry({ delaySeconds: 30 * msg.attempts });
      } else {
        if ("importId" in body) await failImport(env, body.importId, "detection_failed", (e as Error).message);
        else if ("jobId" in body) await failJob(env, body.jobId, (e as Error).message);
        // A content check that keeps failing is rejected by expireStaleScans; a nightly link check waits for the
        // next night; an approved release that cannot be published stays awaiting review for a reviewer; a backup
        // that cannot be dispatched waits for the weekly run (git) or an admin's "back up now".
        else console.error("queued work failed", body, e);
        msg.ack();
      }
    }
  }
}
