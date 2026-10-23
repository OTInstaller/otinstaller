// Community wrapper submissions: anyone signed in packages someone else's open-source tool through the import wizard.
// The checks run first (license, upstream manifest, already packaged or submitted, the PyPI project's source, the
// Dockerfile's rules). Then the community bot, a second GitHub App installed only on osintverse-community, creates the
// wrapper repository and starts its release: a tag when it pins upstream's own image or wheel, the release workflow
// when it builds a Dockerfile that follows the template (others wait for a reviewer to start them). The first release
// waits for a staff or community reviewer, never the submitter, who becomes a maintainer once it is published.
// Routes live in routes/submissions.ts; the tables are in migration 0020.
import { deps, requireSecret, type Env, type User } from "./env";
import { ulid } from "./lib/crypto";
import { apiError } from "./lib/errors";
import { semverParts } from "./lib/manifest";
import * as github from "./hosts/github";
import { HostError, type FileChange } from "./hosts/github";
import {
  COMMUNITY_NAMESPACE, ImportProblem, ZERO, draftProblems, heldManifestProblems, isRedistributable, manifestYaml, wrapperReadme,
  type Detection, type ImportRow,
} from "./imports";
import { RELEASE_TEMPLATES } from "./release-templates";
import { audit } from "./routes/auth";
import { communityRoles, dailyLimit, poster } from "./community";
import { notify } from "./inbox";
import { knownRepo, packagedFrom, readUpstream, requestByNumber, setRequestStatus } from "./requests";
import { OTLITE_REPOS } from "./known-repos";
import { findPin } from "./upstream-pin";

export const OPEN_STATUSES = ["submitted", "releasing", "in_review", "changes_requested", "failed"];
export const MAX_DOCKERFILE = 16 * 1024;
const WORKFLOW = "otinstaller-release.yml";

export type SubmissionStatus = "submitted" | "releasing" | "in_review" | "changes_requested" | "published" | "rejected" | "withdrawn" | "failed";
export type Check = { code: string; message: string };

export type SubmissionRow = {
  id: string; number: number; user_id: string | null; import_id: string | null; request_id: string | null; provider: "github" | "gitlab";
  upstream_path: string; upstream_key: string; upstream_url: string; name: string; runtime: "docker" | "pipx"; builds: number; manifest_json: string;
  dockerfile: string | null; checks_json: string; template_conformant: number; status: SubmissionStatus; wrapper_repo: string | null;
  wrapper_repo_id: string | null; released_version: string | null; tool_id: string | null; reviewer_id: string | null; decision_note: string | null;
  error: string | null; created_at: number; updated_at: number;
};

const keyOf = (provider: string, path: string) => `${provider}:${path.toLowerCase()}`;
const problem = (status: 400 | 403 | 404 | 409, code: string, message: string, problems?: Check[]): never => {
  throw Object.assign(new ImportProblem(status, code, message), problems ? { problems: problems.map((p) => ({ ...p, path: "" })) } : {});
};

// ---------- the Dockerfile ----------

// Official images pinned by tag. A wrapper that needs anything else waits for a reviewer to start its build.
const BASES = /^(alpine:3\.\d+(\.\d+)?|debian:(bookworm|trixie)-slim|python:3\.1\d(\.\d+)?-(slim|alpine)(-bookworm|-trixie)?|golang:1\.\d+(\.\d+)?-(alpine|bookworm|trixie)|rust:1\.\d+(\.\d+)?-(alpine|slim(-bookworm|-trixie)?)|node:2\d(\.\d+)*-(slim|alpine)|ruby:3\.\d+(\.\d+)?-(slim|alpine))$/;

/**
 * The rules a wrapper's Dockerfile should follow: official base images pinned by tag, a non-root user in the final
 * stage, no ADD from a URL or downloaded script piped into a shell, and a pin of the upstream release the watcher can
 * read. Any miss makes it non-conformant (a reviewer starts the build by hand); only size refuses it.
 */
export function dockerfileChecks(dockerfile: string, upstream: string): { refused: Check[]; checks: Check[]; conformant: boolean } {
  const refused: Check[] = [];
  const checks: Check[] = [];
  if (new TextEncoder().encode(dockerfile).length > MAX_DOCKERFILE) refused.push({ code: "dockerfile_too_large", message: `the Dockerfile is over ${MAX_DOCKERFILE / 1024} KB` });
  const lines = dockerfile.split("\n").map((l) => l.trim());
  const stages: string[] = [];
  let lastStageStart = -1;
  lines.forEach((l, i) => {
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
    if (!m) return;
    lastStageStart = i;
    if (!BASES.test(m[1]!) && !stages.includes(m[1]!.toLowerCase())) checks.push({ code: "dockerfile_base", message: `${m[1]} is not an official base image pinned by tag` });
    if (m[2]) stages.push(m[2].toLowerCase());
  });
  if (lastStageStart < 0) checks.push({ code: "dockerfile_base", message: "the Dockerfile has no FROM line" });
  const user = lines.slice(lastStageStart + 1).filter((l) => /^USER\s/i.test(l)).at(-1);
  if (!user || /^USER\s+(root|0)(:|\s|$)/i.test(user)) checks.push({ code: "dockerfile_root", message: "the final stage does not switch to a non-root USER" });
  if (lines.some((l) => /^ADD\s+(--\S+\s+)*https?:\/\//i.test(l))) checks.push({ code: "dockerfile_add_url", message: "ADD downloads from a URL; download in a RUN step with a checksum, or COPY" });
  if (/\b(curl|wget)\b[^|;&\n]*\|\s*(ba|z|da)?sh\b/i.test(dockerfile)) checks.push({ code: "dockerfile_pipe_shell", message: "a downloaded script is piped into a shell" });
  if (!findPin(dockerfile, upstream)) {
    checks.push({ code: "dockerfile_no_pin", message: "no pinned upstream release found (use ARG UPSTREAM_VERSION, go install …@v1.2.3, pip install pkg==1.2.3, or git checkout <tag>)" });
  }
  return { refused, checks, conformant: refused.length === 0 && checks.length === 0 };
}

// ---------- the checks a submission must pass ----------

const levenshtein = (a: string, b: string) => {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
};

/** Whether PyPI says the project's source is the upstream repository (a wheel of the same name by someone else is not it). */
async function pypiPointsAt(pkg: string, upstream: string): Promise<boolean | null> {
  const res = await deps.fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return false;
  if (!res.ok) return null;
  const info = ((await res.json()) as { info: { home_page?: string | null; project_url?: string | null; project_urls?: Record<string, string> | null } }).info;
  const want = upstream.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  const urls = [info.home_page, info.project_url, ...Object.values(info.project_urls ?? {})].filter((u): u is string => typeof u === "string");
  return urls.some((u) => u.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase().startsWith(want));
}

/** Everything that blocks a submission, and what a reviewer should look at. */
export async function submissionChecks(env: Env, user: User, upstream: { provider: "github" | "gitlab"; path: string; url: string }, draft: Record<string, any>, opts: { ignore?: string } = {}) {
  const blocking: Check[] = [];
  const flags: Check[] = [];
  const up = await readUpstream(env, user.id, upstream.provider, upstream.path);
  if (!isRedistributable(up.license)) blocking.push({ code: "license_not_redistributable", message: `${up.path} has ${up.license ? `the license ${up.license}, which` : "no license that"} the registry can't redistribute` });
  else if (draft.license && draft.license !== up.license) blocking.push({ code: "license_mismatch", message: `the manifest says ${draft.license}, but ${up.path} is licensed ${up.license}` });
  if (up.hasManifest) blocking.push({ code: "upstream_has_manifest", message: `${up.path} already has otinstaller.yaml; its maintainers can publish it themselves` });
  const packaged = await packagedFrom(env, up.provider, up.projectId, up.url);
  if (packaged) blocking.push({ code: "already_packaged", message: `${up.path} is in the registry already, as ${packaged}` });
  const open = await env.DB.prepare(
    `SELECT number, upstream_key, name FROM wrapper_submissions WHERE (upstream_key = ? OR name = ?) AND status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(", ")}) AND id != ?`,
  ).bind(keyOf(up.provider, up.path), String(draft.name ?? ""), opts.ignore ?? "").all<{ number: number; upstream_key: string; name: string }>();
  for (const s of open.results) {
    blocking.push(s.upstream_key === keyOf(up.provider, up.path)
      ? { code: "submission_exists", message: `${up.path} is being packaged already, as submission #${s.number}` }
      : { code: "name_taken", message: `another submission (#${s.number}) is packaging a tool called ${s.name}` });
  }
  const names = (await env.DB.prepare(
    `SELECT t.name FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ?1 UNION SELECT old_name FROM aliases WHERE old_namespace = ?1`,
  ).bind(COMMUNITY_NAMESPACE).all<{ name: string }>()).results.map((r) => r.name);
  const name = String(draft.name ?? "");
  if (names.includes(name)) blocking.push({ code: "name_taken", message: `${COMMUNITY_NAMESPACE}/${name} exists already; choose another name` });
  if (draft.runtime?.kind === "pipx" && draft.runtime.package) {
    const ok = await pypiPointsAt(String(draft.runtime.package), up.url).catch(() => null);
    if (ok === false) blocking.push({ code: "pypi_not_upstream", message: `PyPI's ${draft.runtime.package} does not name ${up.path} as its source; it may be someone else's package` });
    if (ok === null) flags.push({ code: "pypi_unchecked", message: "PyPI didn't answer, so whether the package comes from the repository wasn't checked" });
  }
  // For reviewers: lookalike names, a quiet or little-used project, and what the seed survey said.
  const near = [...names, ...Object.values(OTLITE_REPOS)].find((n) => n !== name && Math.abs(n.length - name.length) <= 2 && levenshtein(n, name) <= 2);
  if (near) flags.push({ code: "similar_name", message: `the name is close to ${near}` });
  if (up.pushedAt && up.pushedAt < Date.now() - 2 * 365 * 86_400_000) flags.push({ code: "stale_upstream", message: `nothing was pushed to ${up.path} in two years` });
  if (up.stars !== null && up.stars < 10) flags.push({ code: "few_stars", message: `${up.path} has ${up.stars} stars` });
  const known = knownRepo(up.provider, up.path);
  if (known.dropped) flags.push({ code: "dropped_in_survey", message: `the October 2026 seed survey left it out: ${known.dropped}` });
  if (up.archived) flags.push({ code: "archived_upstream", message: `${up.path} is archived` });
  return { blocking, flags, upstream: up };
}

// ---------- the community bot ----------

/** The bot's token, or 503 when the operator hasn't set it up. */
export async function botToken(env: Env): Promise<string> {
  if (!env.COMMUNITY_APP_ID || !env.COMMUNITY_APP_PRIVATE_KEY || !env.COMMUNITY_INSTALLATION_ID) {
    apiError(503, "community_bot_missing", "community submissions aren't switched on yet", "an osintverse-community admin can package it meanwhile; ask on OTInstaller/feedback");
  }
  return github.installationToken(deps.fetch, requireSecret(env, "COMMUNITY_APP_ID"), requireSecret(env, "COMMUNITY_APP_PRIVATE_KEY"), Number(env.COMMUNITY_INSTALLATION_ID));
}

export const botConfigured = (env: Env) => !!(env.COMMUNITY_APP_ID && env.COMMUNITY_APP_PRIVATE_KEY && env.COMMUNITY_INSTALLATION_ID);

/** The files a wrapper repository holds: manifest, README with credit, and for builds the Dockerfile and release workflow. */
function wrapperFiles(sub: Pick<SubmissionRow, "manifest_json" | "dockerfile" | "builds" | "upstream_url">, handle: string): FileChange[] {
  const draft = JSON.parse(sub.manifest_json) as Record<string, unknown>;
  const readme = `${wrapperReadme(draft, sub.upstream_url)}\nPackaged by @${handle} through the registry's community submissions.\n`;
  const files: FileChange[] = [{ path: "otinstaller.yaml", content: manifestYaml(draft) }, { path: "README.md", content: readme }];
  if (sub.builds) {
    files.push({ path: "Dockerfile", content: sub.dockerfile ?? "" }, { path: `.github/workflows/${WORKFLOW}`, content: RELEASE_TEMPLATES["github-docker"]! });
  }
  return files;
}

/** Starts a release of the manifest's version: the release workflow for builds, else a tag on the branch head. */
async function startRelease(env: Env, token: string, sub: SubmissionRow, actor: User | null) {
  const version = String((JSON.parse(sub.manifest_json) as { version?: string }).version);
  if (sub.builds) await github.dispatchWorkflow(deps.fetch, token, sub.wrapper_repo!, WORKFLOW, "main", { version });
  else await github.createTag(deps.fetch, token, sub.wrapper_repo!, `v${version}`, await github.branchHead(deps.fetch, token, sub.wrapper_repo!, "main"));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE wrapper_submissions SET status = 'releasing', released_version = ?, error = NULL, updated_at = ? WHERE id = ?`).bind(version, now, sub.id),
    audit(env.DB, actor?.id ?? null, actor ? "user" : "system", "submission.release", "submission", sub.id, { version, builds: !!sub.builds }),
  ]);
}

async function reviewers(env: Env): Promise<string[]> {
  return (await env.DB.prepare(`SELECT id AS user_id FROM users WHERE (is_admin = 1 OR is_reviewer = 1) AND banned_at IS NULL UNION SELECT user_id FROM community_roles WHERE role = 'reviewer'`)
    .all<{ user_id: string }>()).results.map((r) => r.user_id);
}

export async function submissionByNumber(env: Env, number: number): Promise<SubmissionRow | null> {
  return env.DB.prepare(`SELECT * FROM wrapper_submissions WHERE number = ?`).bind(number).first<SubmissionRow>();
}

// ---------- submitting ----------

/**
 * Finishes a community import as a submission (mode "submit"): checks it, has the bot create
 * osintverse-community/<name> with the manifest (and Dockerfile and release workflow when it builds), links the
 * repository as a source, and starts the release unless the Dockerfile needs a reviewer first.
 */
export async function submitWrapper(env: Env, user: User, row: ImportRow, opts: { dockerfile?: string; request?: number }): Promise<SubmissionRow> {
  if (row.community !== 1) problem(400, "invalid_mode", `only community imports ({"community": true}) finish with mode "submit"`);
  if (row.status === "finished") problem(409, "import_finished", "this import is already finished");
  if (!row.detection_json || row.status === "detecting" || row.status === "failed") problem(409, "import_not_detected", "detection has not finished for this import");
  if (!botConfigured(env)) await botToken(env);
  const p = await poster(env, user.id);
  const mine = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM wrapper_submissions WHERE user_id = ? AND status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(", ")})`)
    .bind(user.id).first<{ n: number }>())!.n;
  if (mine >= 3 && !user.is_admin) problem(409, "too_many_submissions", "you have 3 submissions waiting already; finish or withdraw one first");
  const facts = (JSON.parse(row.detection_json!) as Detection).facts;
  const draft = JSON.parse(row.draft_manifest_json ?? "{}") as Record<string, any>;
  const name = String(draft.name ?? "");
  const wrapperPath = `${COMMUNITY_NAMESPACE}/${name}`;
  draft.namespace = COMMUNITY_NAMESPACE;
  draft.homepage = facts.url;
  draft.readme = "README.md";
  const rt = draft.runtime as Record<string, any> | undefined;
  const builds = rt?.kind === "docker" && String(rt.image ?? "").endsWith(ZERO);
  if (builds) rt!.image = `ghcr.io/${wrapperPath.toLowerCase()}@sha256:${ZERO}`;
  const dockerfile = builds ? (opts.dockerfile ?? "").replace(/\r\n/g, "\n") : null;

  const manifestProblems = await draftProblems(env, { ...row, url: `https://github.com/${wrapperPath}`, namespace: COMMUNITY_NAMESPACE }, draft);
  if (rt?.kind === "pipx") manifestProblems.push(...heldManifestProblems(draft));
  if (manifestProblems.length) {
    throw Object.assign(new ImportProblem(409, "import_not_ready", `the draft manifest has ${manifestProblems.length} problem(s); fix them first`), { problems: manifestProblems });
  }
  if (builds && !dockerfile?.trim()) problem(400, "dockerfile_required", "upstream publishes no image, so the wrapper builds one: send the Dockerfile that builds it");
  const df = dockerfile ? dockerfileChecks(dockerfile, facts.url) : { refused: [], checks: [], conformant: true };
  const { blocking, flags } = await submissionChecks(env, user, { provider: facts.provider, path: facts.path, url: facts.url }, draft);
  blocking.push(...df.refused);
  if (blocking.length) problem(409, blocking[0]!.code, blocking[0]!.message, blocking);

  const request = opts.request ? await requestByNumber(env, opts.request) : null;
  if (opts.request && (!request || request.repo_key !== keyOf(facts.provider, facts.path))) {
    problem(400, "invalid_body", `request #${opts.request} is not for ${facts.path}`);
  }
  await dailyLimit(env, "submission", user.id, 3);
  const token = await botToken(env);
  let repo: github.GithubRepo;
  try {
    repo = await github.createOrgRepo(deps.fetch, token, COMMUNITY_NAMESPACE, name, `${draft.summary ?? ""} (community package of ${facts.path})`, facts.url);
  } catch (e) {
    if (e instanceof HostError && e.status === 422) problem(409, "name_taken", `${wrapperPath} exists on GitHub already; choose another name`);
    throw e;
  }
  const now = Date.now();
  const id = ulid(now);
  const sub: SubmissionRow = {
    id, number: 0, user_id: user.id, import_id: row.id, request_id: request?.id ?? null, provider: facts.provider, upstream_path: facts.path,
    upstream_key: keyOf(facts.provider, facts.path), upstream_url: facts.url, name, runtime: rt?.kind === "pipx" ? "pipx" : "docker", builds: builds ? 1 : 0,
    manifest_json: JSON.stringify(draft), dockerfile, checks_json: JSON.stringify({ flags, dockerfile: df.checks }), template_conformant: df.conformant ? 1 : 0,
    status: "submitted", wrapper_repo: repo.full_name, wrapper_repo_id: String(repo.id), released_version: null, tool_id: null, reviewer_id: null,
    decision_note: null, error: null, created_at: now, updated_at: now,
  };
  for (const file of wrapperFiles(sub, p.handle ?? user.login)) {
    await github.putFile(deps.fetch, token, repo.full_name, "main", file, `Add ${file.path} (community package of ${facts.path})`);
  }
  // The registry's own App must cover the new repository (installed on all of osintverse-community) to see its tags.
  const inst = await env.DB.prepare(
    `SELECT i.github_installation_id, i.namespace_id FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE n.name = ? AND i.suspended_at IS NULL LIMIT 1`,
  ).bind(COMMUNITY_NAMESPACE).first<{ github_installation_id: number; namespace_id: string }>();
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO wrapper_submissions (id, number, user_id, import_id, request_id, provider, upstream_path, upstream_key, upstream_url, name, runtime, builds,
         manifest_json, dockerfile, checks_json, template_conformant, status, wrapper_repo, wrapper_repo_id, created_at, updated_at)
       SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ? FROM wrapper_submissions`,
    ).bind(id, user.id, row.id, sub.request_id, sub.provider, sub.upstream_path, sub.upstream_key, sub.upstream_url, name, sub.runtime, sub.builds,
      sub.manifest_json, dockerfile, sub.checks_json, sub.template_conformant, sub.wrapper_repo, sub.wrapper_repo_id, now, now),
    db.prepare(
      `INSERT INTO sources (id, namespace_id, provider, project_id, path, url, default_branch, installation_id, connected_by, manifest_mode, visibility, created_at)
       VALUES (?, ?, 'github', ?, ?, ?, 'main', ?, ?, 'repo', 'public', ?) ON CONFLICT (provider, project_id) DO NOTHING`,
    ).bind(ulid(now), inst?.namespace_id ?? null, String(repo.id), repo.full_name, repo.html_url, inst?.github_installation_id ?? null, user.id, now),
    db.prepare(`UPDATE imports SET status = 'finished', finish_mode = 'wrapper', wrapper_path = ?, updated_at = ? WHERE id = ?`).bind(`github:${repo.full_name}`, now, row.id),
    audit(db, user.id, "user", "submission.create", "submission", id, { upstream: facts.url, wrapper: repo.full_name, conformant: df.conformant }),
  ]);
  const saved = (await db.prepare(`SELECT * FROM wrapper_submissions WHERE id = ?`).bind(id).first<SubmissionRow>())!;
  if (request && ["open", "accepted"].includes(request.status)) await setRequestStatus(env, null, request, "in_progress", { note: `Being packaged in submission #${saved.number}.` });
  if (df.conformant) await startRelease(env, token, saved, user);
  await notify(env, await reviewers(env), {
    kind: "status", scope: "community", summary: `New community submission #${saved.number}: ${name} (${facts.path})${df.conformant ? "" : ", waiting for a reviewer to start its build"}`,
    path: `/submissions/${saved.number}`, actor_id: user.id,
  });
  return (await db.prepare(`SELECT * FROM wrapper_submissions WHERE id = ?`).bind(id).first<SubmissionRow>())!;
}

// ---------- the pipeline's hooks ----------

/** For record(): a new tool from a submission's repository waits for a reviewer and remembers who submitted it. */
export function markSubmittedTool(db: D1Database, toolId: string, repoId: string | null): D1PreparedStatement[] {
  if (!repoId) return [];
  const live = `status NOT IN ('rejected', 'withdrawn')`;
  return [
    db.prepare(
      `UPDATE tools SET needs_first_review = 1, submitted_by = (SELECT user_id FROM wrapper_submissions WHERE wrapper_repo_id = ?1 AND ${live} LIMIT 1),
         upstream_url = COALESCE(upstream_url, (SELECT upstream_url FROM wrapper_submissions WHERE wrapper_repo_id = ?1 AND ${live} LIMIT 1))
       WHERE id = ?2 AND EXISTS (SELECT 1 FROM wrapper_submissions WHERE wrapper_repo_id = ?1 AND ${live})`,
    ).bind(repoId, toolId),
    db.prepare(`UPDATE wrapper_submissions SET tool_id = ?2 WHERE wrapper_repo_id = ?1 AND ${live}`).bind(repoId, toolId),
  ];
}

/** For applyScanResults: the first release scanned (waiting for review) or failed its scan. */
export async function firstReleaseScanned(env: Env, toolId: string, outcome: "in_review" | "failed", detail?: string) {
  const sub = await env.DB.prepare(`SELECT * FROM wrapper_submissions WHERE tool_id = ? AND status IN ('releasing', 'submitted') LIMIT 1`).bind(toolId).first<SubmissionRow>();
  if (!sub) return;
  await env.DB.prepare(`UPDATE wrapper_submissions SET status = ?, error = ?, updated_at = ? WHERE id = ?`).bind(outcome, detail ?? null, Date.now(), sub.id).run();
  const path = `/submissions/${sub.number}`;
  if (sub.user_id) {
    await notify(env, [sub.user_id], {
      kind: "status", scope: "community", path, tool_id: toolId,
      summary: outcome === "in_review" ? `${sub.name} passed its scans and waits for a reviewer` : `${sub.name}'s first release failed its scan: ${detail ?? "see the submission"}`,
    });
  }
  if (outcome === "in_review") await notify(env, await reviewers(env), { kind: "status", scope: "community", path, tool_id: toolId, summary: `Submission #${sub.number} (${sub.name}) is ready for review` });
}

/** For publishVersion: a reviewed first release is out, so its submitter becomes a maintainer. */
export async function firstReleasePublished(env: Env, toolId: string) {
  const db = env.DB;
  const t = await db.prepare(`SELECT needs_first_review, submitted_by FROM tools WHERE id = ?`).bind(toolId).first<{ needs_first_review: number; submitted_by: string | null }>();
  if (!t?.needs_first_review) return;
  const now = Date.now();
  const sub = await db.prepare(`SELECT * FROM wrapper_submissions WHERE tool_id = ? AND status NOT IN ('rejected', 'withdrawn') LIMIT 1`).bind(toolId).first<SubmissionRow>();
  await db.batch([
    db.prepare(`UPDATE tools SET needs_first_review = 0 WHERE id = ?`).bind(toolId),
    ...(t.submitted_by ? [db.prepare(`INSERT OR IGNORE INTO tool_maintainers (tool_id, user_id, reason, created_at) VALUES (?, ?, 'submitter', ?)`).bind(toolId, t.submitted_by, now)] : []),
    ...(sub ? [db.prepare(`UPDATE wrapper_submissions SET status = 'published', updated_at = ? WHERE id = ?`).bind(now, sub.id)] : []),
  ]);
  if (sub?.user_id) await notify(env, [sub.user_id], { kind: "status", scope: "community", path: `/submissions/${sub.number}`, tool_id: toolId, summary: `${sub.name} is published; you're one of its maintainers now` });
}

// ---------- decisions ----------

async function requireSubmissionReviewer(env: Env, actor: User, sub: SubmissionRow) {
  if (!(await communityRoles(env, actor)).has("reviewer")) apiError(403, "not_reviewer", "only staff and community reviewers can decide submissions");
  if (sub.user_id === actor.id) apiError(403, "self_review", "someone other than the submitter has to review a submission");
}

/** The version of a submission's tool that waits for review, if any. */
async function waitingVersion(env: Env, sub: SubmissionRow) {
  return sub.tool_id
    ? env.DB.prepare(`SELECT id, version FROM versions WHERE tool_id = ? AND status = 'awaiting_review' ORDER BY created_at DESC LIMIT 1`).bind(sub.tool_id).first<{ id: string; version: string }>()
    : null;
}

/** Approves the first release: it is published (publishVersion then makes the submitter a maintainer). */
export async function approveSubmission(env: Env, actor: User, sub: SubmissionRow, note: string, publish: (versionId: string) => Promise<void>) {
  await requireSubmissionReviewer(env, actor, sub);
  const v = await waitingVersion(env, sub);
  if (sub.status !== "in_review" || !v) apiError(409, "not_pending", `submission #${sub.number} is ${sub.status.replace("_", " ")}, with no release waiting for review`);
  await env.DB.batch([
    env.DB.prepare(`UPDATE wrapper_submissions SET reviewer_id = ?, decision_note = ?, updated_at = ? WHERE id = ?`).bind(actor.id, note || null, Date.now(), sub.id),
    audit(env.DB, actor.id, "user", "submission.approve", "submission", sub.id, { version: v.version }),
  ]);
  await publish(v.id);
}

/** Sends a submission back to its submitter, or turns it down (the repository is archived, never deleted). */
export async function decideSubmission(env: Env, actor: User, sub: SubmissionRow, decision: "changes_requested" | "rejected", note: string) {
  await requireSubmissionReviewer(env, actor, sub);
  if (!OPEN_STATUSES.includes(sub.status)) apiError(409, "not_pending", `submission #${sub.number} is ${sub.status.replace("_", " ")}`);
  if (!note.trim()) apiError(400, "invalid_body", "say what needs to change, or why it is turned down, in {note}");
  const v = await waitingVersion(env, sub);
  const db = env.DB;
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE wrapper_submissions SET status = ?, reviewer_id = ?, decision_note = ?, updated_at = ? WHERE id = ?`).bind(decision, actor.id, note.slice(0, 2000), now, sub.id),
    ...(v ? [db.prepare(`UPDATE versions SET status = 'rejected', rejected_reason = 'review_rejected' WHERE id = ?`).bind(v.id),
      db.prepare(`UPDATE publish_jobs SET status = 'rejected', error_code = 'review_rejected', error_detail = ?, updated_at = ? WHERE version_id = ?`).bind(note.slice(0, 500), now, v.id)] : []),
    audit(db, actor.id, "user", `submission.${decision === "rejected" ? "reject" : "request_changes"}`, "submission", sub.id, { note }),
  ]);
  if (decision === "rejected") await closeOut(env, sub);
  if (sub.user_id) {
    await notify(env, [sub.user_id], {
      kind: "status", scope: "community", path: `/submissions/${sub.number}`,
      summary: decision === "rejected" ? `Submission #${sub.number} (${sub.name}) was turned down` : `A reviewer asked for changes to submission #${sub.number} (${sub.name})`,
    });
  }
}

/** Archives the wrapper repository and puts a linked request back to accepted. */
async function closeOut(env: Env, sub: SubmissionRow) {
  if (sub.wrapper_repo && botConfigured(env)) {
    await github.archiveRepo(deps.fetch, await botToken(env), sub.wrapper_repo).catch((e) => console.error("archiving the wrapper failed", e));
  }
  const request = sub.request_id ? await env.DB.prepare(`SELECT * FROM tool_requests WHERE id = ?`).bind(sub.request_id).first<import("./requests").RequestRow>() : null;
  if (request?.status === "in_progress") await setRequestStatus(env, null, request, "accepted", { note: `Submission #${sub.number} didn't go ahead; someone else can package it.` });
}

/** The submitter withdraws it. */
export async function withdrawSubmission(env: Env, user: User, sub: SubmissionRow) {
  if (sub.user_id !== user.id && !user.is_admin) apiError(403, "forbidden", "only the submitter can withdraw a submission");
  if (!OPEN_STATUSES.includes(sub.status)) apiError(409, "not_pending", `submission #${sub.number} is ${sub.status.replace("_", " ")}`);
  await env.DB.batch([
    env.DB.prepare(`UPDATE wrapper_submissions SET status = 'withdrawn', updated_at = ? WHERE id = ?`).bind(Date.now(), sub.id),
    audit(env.DB, user.id, "user", "submission.withdraw", "submission", sub.id),
  ]);
  await closeOut(env, sub);
}

/** A reviewer starts the build of a Dockerfile that doesn't follow the template, after reading it. */
export async function startSubmission(env: Env, actor: User, sub: SubmissionRow) {
  await requireSubmissionReviewer(env, actor, sub);
  if (sub.status !== "submitted") apiError(409, "not_pending", `submission #${sub.number} is ${sub.status.replace("_", " ")}`);
  await startRelease(env, await botToken(env), sub, actor);
}

/**
 * The submitter changes the manifest or Dockerfile while it waits, was sent back or failed: checked again, committed to
 * the wrapper repository, and released again (a new patch version when the last one was already tagged).
 */
export async function updateSubmission(env: Env, user: User, sub: SubmissionRow, change: { manifest?: unknown; dockerfile?: unknown }) {
  if (sub.user_id !== user.id) apiError(403, "forbidden", "only the submitter can change a submission");
  if (!["submitted", "changes_requested", "failed"].includes(sub.status)) apiError(409, "not_pending", `submission #${sub.number} is ${sub.status.replace("_", " ")}`);
  const draft = { ...(JSON.parse(sub.manifest_json) as Record<string, any>) };
  if (change.manifest !== undefined) {
    if (!change.manifest || typeof change.manifest !== "object" || Array.isArray(change.manifest)) apiError(400, "invalid_body", "manifest is an object of fields to change");
    for (const [k, v] of Object.entries(change.manifest as Record<string, unknown>)) {
      if (["namespace", "homepage", "readme", "name"].includes(k)) continue;
      if (v === null) delete draft[k];
      else draft[k] = v;
    }
  }
  if (sub.builds) draft.runtime = { ...draft.runtime, image: `ghcr.io/${sub.wrapper_repo!.toLowerCase()}@sha256:${ZERO}` };
  // A version that was already tagged can't be released again.
  if (sub.released_version && sub.released_version === draft.version) {
    const v = semverParts(String(draft.version));
    draft.version = `${v.major}.${v.minor}.${v.patch + 1}`;
  }
  const dockerfile = typeof change.dockerfile === "string" ? change.dockerfile.replace(/\r\n/g, "\n") : sub.dockerfile;
  const problems = await draftProblems(env, { url: `https://github.com/${sub.wrapper_repo}`, namespace: COMMUNITY_NAMESPACE } as ImportRow, draft);
  if (sub.runtime === "pipx") problems.push(...heldManifestProblems(draft));
  if (problems.length) throw Object.assign(new ImportProblem(409, "import_not_ready", `the manifest has ${problems.length} problem(s)`), { problems });
  const df = sub.builds && dockerfile ? dockerfileChecks(dockerfile, sub.upstream_url) : { refused: [], checks: [], conformant: true };
  if (df.refused.length) problem(409, df.refused[0]!.code, df.refused[0]!.message, df.refused);
  const { blocking, flags } = await submissionChecks(env, user, { provider: sub.provider, path: sub.upstream_path, url: sub.upstream_url }, draft, { ignore: sub.id });
  const real = blocking.filter((b) => b.code !== "name_taken" && b.code !== "already_packaged");
  if (real.length) problem(409, real[0]!.code, real[0]!.message, real);
  const next: SubmissionRow = { ...sub, manifest_json: JSON.stringify(draft), dockerfile, checks_json: JSON.stringify({ flags, dockerfile: df.checks }), template_conformant: df.conformant ? 1 : 0 };
  const token = await botToken(env);
  const p = await poster(env, user.id);
  for (const file of wrapperFiles(next, p.handle ?? user.login)) {
    if (file.path === "README.md") continue;
    await github.putFile(deps.fetch, token, sub.wrapper_repo!, "main", file, `Update ${file.path} (submission #${sub.number})`);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE wrapper_submissions SET manifest_json = ?, dockerfile = ?, checks_json = ?, template_conformant = ?, status = 'submitted', error = NULL, updated_at = ? WHERE id = ?`)
      .bind(next.manifest_json, dockerfile, next.checks_json, next.template_conformant, Date.now(), sub.id),
    audit(env.DB, user.id, "user", "submission.update", "submission", sub.id, { version: draft.version }),
  ]);
  const saved = (await submissionByNumber(env, sub.number))!;
  if (df.conformant) await startRelease(env, token, saved, user);
  return (await submissionByNumber(env, sub.number))!;
}
