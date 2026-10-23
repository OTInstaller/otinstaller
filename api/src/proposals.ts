// Change proposals: a community wrapper's maintainers change more than its pin through the registry: the manifest
// (inputs, command, description, keys, ethics), the Dockerfile or the README. The wrapper repository belongs to
// osintverse-community, so they can't push to it. The registry checks the files the way it checks a submission, the
// community bot opens a pull request with them, and a staff or community reviewer who isn't the proposer approves it:
// the bot merges it and starts the release (the release workflow for builds, a tag otherwise), which is built, signed
// and scanned like any other. Pin-only bumps the upstream watcher opens stay in bumps.ts. Routes live in
// routes/proposals.ts; the table is in migration 0027.
import { deps, type Env, type User } from "./env";
import { ulid } from "./lib/crypto";
import { apiError } from "./lib/errors";
import { MAX_SIZE, parseManifest, semverParts, type Problem } from "./lib/manifest";
import * as github from "./hosts/github";
import { HostError } from "./hosts/github";
import { COMMUNITY_NAMESPACE, heldManifestProblems } from "./imports";
import { audit } from "./routes/auth";
import { communityRoles, dailyLimit, poster, screen } from "./community";
import { maintainers, notify } from "./inbox";
import { canRelease } from "./bumps";
import { botToken, dockerfileChecks, MAX_DOCKERFILE, reviewers, type Check } from "./submissions";

export const PROPOSAL_FILES = ["otinstaller.yaml", "Dockerfile", "README.md"] as const;
export type ProposalFile = (typeof PROPOSAL_FILES)[number];
export type Files = Partial<Record<ProposalFile, string>>;
export const PROPOSAL_STATUSES = ["open", "changes_requested", "merged", "rejected", "withdrawn"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const OPEN_STATUSES: ProposalStatus[] = ["open", "changes_requested"];
export const DECISIONS = ["approve", "changes_requested", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

const MAX_FILE: Record<ProposalFile, number> = { "otinstaller.yaml": MAX_SIZE, Dockerfile: MAX_DOCKERFILE, "README.md": 100 * 1024 };
export const MAX_NOTE = 2000;
/** Open proposals one person may have on one package. */
const OPEN_PER_PERSON = 3;
const WORKFLOW = "otinstaller-release.yml";
/** Fields that say which package this is; a proposal can't change them. */
const IDENTITY = ["schema", "kind", "name", "namespace", "homepage", "license", "readme"] as const;

export type ProposalRow = {
  id: string; tool_id: string; pr_number: number; url: string; branch: string; proposer_id: string | null; title: string; note: string | null;
  files_json: string; version: string; builds: number; checks_json: string; status: ProposalStatus; reviewer_id: string | null;
  decision_note: string | null; decided_at: number | null; released_version: string | null; created_at: number; updated_at: number;
};

/** A community wrapper, with what proposing and releasing a change needs. */
export type Wrapper = { id: string; name: string; ns: string; namespace_id: string; upstream_url: string; wrapper: string; manifest_json: string };

/** The community wrapper `ns/name`, or 404; packages in a publisher's own repository take no proposals. */
export async function wrapperByRef(env: Env, ns: string, name: string): Promise<Wrapper> {
  const t = await env.DB.prepare(
    `SELECT t.id, t.name, n.name AS ns, t.namespace_id, t.upstream_url, s.path AS wrapper, v.manifest_json
     FROM tools t JOIN namespaces n ON n.id = t.namespace_id JOIN versions v ON v.id = t.latest_version_id LEFT JOIN sources s ON s.tool_id = t.id AND s.provider = 'github'
     WHERE n.name = ? AND t.name = ? AND t.status != 'removed'`,
  ).bind(ns, name).first<Wrapper & { upstream_url: string | null; wrapper: string | null }>();
  if (!t) apiError(404, "tool_not_found", `${ns}/${name} is not in the registry`);
  if (!t.upstream_url || !t.wrapper || t.ns !== COMMUNITY_NAMESPACE || !t.wrapper.toLowerCase().startsWith(`${COMMUNITY_NAMESPACE}/`)) {
    apiError(409, "not_a_wrapper", `${ns}/${name} is published from its own repository, so changes go there`, "open an issue on its page, or a pull request in its repository");
  }
  return t as Wrapper;
}

export async function proposalByNumber(env: Env, toolId: string, number: number): Promise<ProposalRow | null> {
  return env.DB.prepare(`SELECT * FROM change_proposals WHERE tool_id = ? AND pr_number = ?`).bind(toolId, number).first<ProposalRow>();
}

/** Whether someone may propose changes to a wrapper: its maintainers and reviewers. */
export async function canPropose(env: Env, user: User | null, t: Pick<Wrapper, "id" | "namespace_id">): Promise<boolean> {
  const who = await canRelease(env, user, t);
  return who.maintainer || who.reviewer;
}

/** The wrapper's files on its main branch, as a proposal starts from them. */
export async function currentFiles(token: string, t: Pick<Wrapper, "wrapper">): Promise<Record<ProposalFile, string | null>> {
  const read = await Promise.all(PROPOSAL_FILES.map((f) => github.fileAt(deps.fetch, token, t.wrapper, f, "main")));
  return Object.fromEntries(PROPOSAL_FILES.map((f, i) => [f, read[i]!])) as Record<ProposalFile, string | null>;
}

/** The newest version the package ever had (any status: a version number is never reused) and the one after it. */
export async function nextVersion(env: Env, toolId: string): Promise<{ latest: string | null; next: string }> {
  const v = await env.DB.prepare(
    `SELECT version FROM versions WHERE tool_id = ? ORDER BY semver_major DESC, semver_minor DESC, semver_patch DESC, semver_pre = '' DESC LIMIT 1`,
  ).bind(toolId).first<{ version: string }>();
  if (!v) return { latest: null, next: "1.0.0" };
  const p = semverParts(v.version);
  return { latest: v.version, next: `${p.major}.${p.minor}.${p.patch + 1}` };
}

const newer = (a: string, b: string) => {
  const x = semverParts(a);
  const y = semverParts(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
};

// ---------- checking a proposal ----------

/** Plain one-paragraph text without control characters. */
const plain = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

/** The files a request sends, as {path: content}; anything else is refused. */
export function filesInput(input: unknown): Files {
  if (!input || typeof input !== "object" || Array.isArray(input)) apiError(400, "invalid_body", `send {files} as {path: content} for ${PROPOSAL_FILES.join(", ")}`);
  const out: Files = {};
  for (const [path, content] of Object.entries(input as Record<string, unknown>)) {
    if (!(PROPOSAL_FILES as readonly string[]).includes(path)) {
      apiError(400, "invalid_body", `a proposal can change ${PROPOSAL_FILES.join(", ")}; not ${path}`, "the release workflow and other files stay as the registry wrote them");
    }
    if (typeof content !== "string") apiError(400, "invalid_body", `${path} must be the file's whole text`);
    out[path as ProposalFile] = content.replace(/\r\n/g, "\n");
  }
  return out;
}

/** Top-level manifest fields that differ (and runtime's own fields), leaving out the version and the build's digest. */
function changedFields(a: Record<string, any>, b: Record<string, any>, builds: boolean): string[] {
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "version" || same(a[k], b[k])) continue;
    if (k === "runtime" && a.runtime && b.runtime) {
      for (const r of new Set([...Object.keys(a.runtime), ...Object.keys(b.runtime)])) {
        if (!(builds && r === "image") && !same(a.runtime[r], b.runtime[r])) out.push(`runtime.${r}`);
      }
    } else out.push(k);
  }
  return out;
}

/** The repository part of an image reference (without tag or digest). */
const imageRepo = (image: unknown) => String(image ?? "").split("@")[0]!.replace(/:[^/]*$/, "").toLowerCase();

export interface Checked {
  /** What the pull request writes: the changed files, and otinstaller.yaml with the new version. */
  files: Files;
  version: string;
  checks: Check[];
}

/**
 * Checks proposed files against the wrapper's main branch: only files that differ count; the manifest must validate,
 * keep the package's identity and, for builds, the image the release workflow pins; its version is moved past every
 * version the package had. The Dockerfile follows the submission rules (size refuses, the rest is for the reviewer).
 * Secrets refuse a proposal; what looks like personal data is shown to the reviewer.
 */
export function checkProposal(current: Record<ProposalFile, string | null>, proposed: Files, ctx: { upstream: string; latest: string | null; next: string }): Checked {
  const changed: Files = {};
  for (const f of PROPOSAL_FILES) {
    const text = proposed[f];
    if (text === undefined || text === current[f]) continue;
    if (new TextEncoder().encode(text).length > MAX_FILE[f]) apiError(400, "proposal_file_too_large", `${f} can be at most ${MAX_FILE[f] / 1024} KB`);
    if (!text.trim()) apiError(400, "invalid_body", `${f} can't be empty`);
    changed[f] = text;
  }
  if (!Object.keys(changed).length) apiError(400, "proposal_unchanged", "nothing in the proposal differs from the wrapper's main branch");
  if (!current["otinstaller.yaml"]) apiError(409, "not_a_wrapper", "the wrapper repository has no otinstaller.yaml on its main branch", "ask a reviewer to look at the repository");
  const builds = current.Dockerfile !== null;
  if (changed.Dockerfile !== undefined && !builds) {
    apiError(400, "no_dockerfile", "this package pins upstream's own image or wheel, so it has no Dockerfile to change", "change runtime in otinstaller.yaml instead");
  }

  const checks: Check[] = [];
  for (const [path, text] of Object.entries(changed)) {
    const hits = screen(text);
    if (hits.includes("secret")) apiError(400, "secret_in_proposal", `${path} looks like it holds a token, key or password`, "take it out: keys belong in `ot keys`, never in a package");
    if (hits.length) checks.push({ code: "personal_data", message: `${path} looks like it holds ${hits.join(", ").replace(/_/g, " ")}` });
  }

  // The manifest: the proposed one, or main's with the version moved on.
  const was = parseManifest(current["otinstaller.yaml"]).manifest;
  let yaml = changed["otinstaller.yaml"] ?? current["otinstaller.yaml"];
  const parsed = parseManifest(yaml);
  if (!parsed.manifest || parsed.problems.length) {
    apiError(409, "proposal_invalid", `otinstaller.yaml has ${parsed.problems.length} problem(s)`, "`ot validate` shows the same problems", { problems: parsed.problems });
  }
  const m = parsed.manifest;
  const problems: Problem[] = [];
  if (was) {
    for (const k of IDENTITY) {
      if (JSON.stringify(was[k] ?? null) !== JSON.stringify(m[k] ?? null)) problems.push({ code: "protected_field", path: `/${k}`, message: `${k} can't change in a proposal` });
    }
    if (was.runtime?.kind !== m.runtime?.kind) problems.push({ code: "protected_field", path: "/runtime/kind", message: "runtime.kind can't change in a proposal" });
    if (builds && imageRepo(was.runtime?.image) !== imageRepo(m.runtime?.image)) {
      problems.push({ code: "protected_field", path: "/runtime/image", message: "the release workflow builds and pins this package's image; leave runtime.image as it is" });
    }
  }
  if (!builds) problems.push(...heldManifestProblems(m as Record<string, any>));
  if (problems.length) apiError(409, problems[0]!.code === "protected_field" ? "protected_field" : "proposal_invalid", problems[0]!.message, undefined, { problems });

  // A release needs a version the package never had.
  let version = m.version;
  if (/-/.test(version) || (ctx.latest && newer(version, ctx.latest) <= 0)) {
    version = ctx.next;
    yaml = yaml.replace(/^version:[ \t]*["']?[^\s"'#]+["']?/m, `version: ${version}`);
  }
  if (yaml !== current["otinstaller.yaml"]) changed["otinstaller.yaml"] = yaml;

  if (was) {
    const fields = changedFields(was, m, builds);
    if (fields.length) checks.push({ code: "fields_changed", message: `changes ${fields.join(", ")}` });
    if (fields.some((f) => f === "ethics" || f === "network" || f === "secrets")) {
      checks.push({ code: "ethics_changed", message: "changes what the package says about contacting targets, personal data, network use or keys; check it against the tool" });
    }
  }
  if (changed.Dockerfile !== undefined) {
    const df = dockerfileChecks(changed.Dockerfile, ctx.upstream);
    if (df.refused.length) apiError(409, df.refused[0]!.code, df.refused[0]!.message, undefined, { problems: df.refused.map((p) => ({ ...p, path: "" })) });
    checks.push(...df.checks);
  }
  const files = Object.fromEntries(PROPOSAL_FILES.filter((f) => changed[f] !== undefined).map((f) => [f, changed[f]])) as Files;
  return { files, version, checks };
}

// ---------- the pull request ----------

const refOf = (t: Pick<Wrapper, "ns" | "name">) => `${t.ns}/${t.name}`;

/** What the bot writes in the pull request. The note is shown as text, so it can't mention people or add links. */
function pullBody(env: Env, t: Wrapper, p: { handle: string; note: string; version: string; checks: Check[]; number?: number }) {
  const fence = (s: string) => "```text\n" + s.replace(/```/g, "'''") + "\n```";
  return [
    `Proposed on otinstaller.com by ${p.handle} (${env.SITE_URL}/people/${p.handle}), a maintainer of ${refOf(t)}.`,
    p.note ? `\n${fence(p.note)}` : "",
    `\nA staff or community reviewer who isn't the proposer approves it on the registry${p.number ? ` (${env.SITE_URL}/${refOf(t)}/changes/${p.number})` : ""}; ` +
      `the registry then merges it and releases ${refOf(t)} ${p.version}, which is built, signed and scanned like any other release.`,
    p.checks.length ? `\nFor the reviewer:\n${p.checks.map((c) => `- ${c.message}`).join("\n")}` : "",
  ].join("\n");
}

/** A GitHub failure while the bot works, as a clear error rather than a 500. */
function hostFailed(e: unknown): never {
  if (e instanceof HostError) apiError(503, "github_failed", `GitHub refused the community bot: ${e.message}`, "try again in a few minutes; if it keeps failing, ask on OTInstaller/feedback");
  throw e;
}

// ---------- proposing ----------

export interface ProposalInput {
  title?: unknown;
  note?: unknown;
  files?: unknown;
}

function titleOf(v: unknown): string {
  const title = typeof v === "string" ? plain(v.replace(/\s+/g, " "), 100) : "";
  if (title.length < 5) apiError(400, "invalid_body", "give a title of at least 5 characters, such as \"Add the --json output\"");
  return title;
}

function noteOf(v: unknown): string {
  const note = typeof v === "string" ? plain(v, MAX_NOTE) : "";
  if (note && screen(note).length) apiError(400, "note_screened", "the note looks like it holds personal data or a secret", "say what the change does and why, without data about anyone");
  return note;
}

/** Opens a proposal: checks it, has the bot open the pull request, and tells reviewers and the other maintainers. */
export async function createProposal(env: Env, user: User, t: Wrapper, input: ProposalInput): Promise<ProposalRow> {
  if (!(await canPropose(env, user, t))) apiError(403, "not_package_maintainer", `only the maintainers of ${refOf(t)} and reviewers can propose changes to it`, "open an issue on its page instead");
  const title = titleOf(input.title);
  const note = noteOf(input.note);
  const files = filesInput(input.files);
  const p = await poster(env, user.id);
  const open = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_proposals WHERE tool_id = ? AND proposer_id = ? AND status IN ('open', 'changes_requested')`)
    .bind(t.id, user.id).first<{ n: number }>())!.n;
  if (open >= OPEN_PER_PERSON) apiError(409, "too_many_proposals", `you have ${open} proposals open on ${refOf(t)}; finish or withdraw one first`);
  await dailyLimit(env, "proposal", user.id, 5);
  const token = await botToken(env);
  const current = await currentFiles(token, t).catch(hostFailed);
  const checked = checkProposal(current, files, { upstream: t.upstream_url, ...(await nextVersion(env, t.id)) });
  const now = Date.now();
  const id = ulid(now);
  const branch = `otinstaller/proposal-${id.slice(-10).toLowerCase()}`;
  const handle = p.handle ?? user.login;
  const pr = await github.openPullRequest(deps.fetch, token, t.wrapper, "main", branch, toChanges(checked.files), title,
    pullBody(env, t, { handle, note, version: checked.version, checks: checked.checks })).catch(hostFailed);
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO change_proposals (id, tool_id, pr_number, url, branch, proposer_id, title, note, files_json, version, builds, checks_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, t.id, pr.number, pr.url, branch, user.id, title, note || null, JSON.stringify(checked.files), checked.version, current.Dockerfile !== null ? 1 : 0,
      JSON.stringify(checked.checks), now, now),
    audit(db, user.id, "user", "proposal.open", "tool", t.id, { pr: pr.number, files: Object.keys(checked.files), version: checked.version }),
  ]);
  // The pull request can link its page now that the number is known.
  await github.updatePull(deps.fetch, token, t.wrapper, pr.number, { title, body: pullBody(env, t, { handle, note, version: checked.version, checks: checked.checks, number: pr.number }) })
    .catch((e) => console.error("linking the proposal's page failed", e));
  const item = { kind: "proposal" as const, scope: "community" as const, path: `/${refOf(t)}/changes/${pr.number}`, tool_id: t.id, actor_id: user.id };
  await notify(env, await reviewers(env), { ...item, summary: `${handle} proposed a change to ${refOf(t)}: ${title}` });
  await notify(env, await maintainers(env, t.namespace_id, t.id), { ...item, summary: `${handle} proposed a change to ${refOf(t)}, which you maintain: ${title}` });
  return (await proposalByNumber(env, t.id, pr.number))!;
}

const toChanges = (files: Files): github.FileChange[] => PROPOSAL_FILES.filter((f) => files[f] !== undefined).map((f) => ({ path: f, content: files[f]! }));

/**
 * The proposer changes their proposal while it is open or sent back: the files are checked again and the branch is
 * rewritten from main, so the pull request shows the new files. A proposal sent back goes back to the reviewers.
 */
export async function updateProposal(env: Env, user: User, t: Wrapper, p: ProposalRow, input: ProposalInput): Promise<ProposalRow> {
  if (p.proposer_id !== user.id) apiError(403, "forbidden", "only the person who proposed a change can edit it");
  if (!OPEN_STATUSES.includes(p.status)) apiError(409, "proposal_closed", `proposal #${p.pr_number} is ${p.status}`);
  const title = input.title === undefined ? p.title : titleOf(input.title);
  const note = input.note === undefined ? p.note ?? "" : noteOf(input.note);
  const files = input.files === undefined ? (JSON.parse(p.files_json) as Files) : filesInput(input.files);
  const who = await poster(env, user.id);
  const token = await botToken(env);
  const current = await currentFiles(token, t).catch(hostFailed);
  const checked = checkProposal(current, files, { upstream: t.upstream_url, ...(await nextVersion(env, t.id)) });
  const handle = who.handle ?? user.login;
  const body = pullBody(env, t, { handle, note, version: checked.version, checks: checked.checks, number: p.pr_number });
  await github.openPullRequest(deps.fetch, token, t.wrapper, "main", p.branch, toChanges(checked.files), title, body).catch(hostFailed);
  await github.updatePull(deps.fetch, token, t.wrapper, p.pr_number, { title, body }).catch(hostFailed);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE change_proposals SET title = ?, note = ?, files_json = ?, version = ?, builds = ?, checks_json = ?, status = 'open', updated_at = ? WHERE id = ?`,
    ).bind(title, note || null, JSON.stringify(checked.files), checked.version, current.Dockerfile !== null ? 1 : 0, JSON.stringify(checked.checks), now, p.id),
    audit(env.DB, user.id, "user", "proposal.update", "tool", t.id, { pr: p.pr_number, files: Object.keys(checked.files) }),
  ]);
  if (p.status === "changes_requested") {
    await notify(env, p.reviewer_id ? [p.reviewer_id] : await reviewers(env), {
      kind: "proposal", scope: "community", path: `/${refOf(t)}/changes/${p.pr_number}`, tool_id: t.id, actor_id: user.id,
      summary: `${handle} changed their proposal for ${refOf(t)} (#${p.pr_number}): ${title}`,
    });
  }
  return (await proposalByNumber(env, t.id, p.pr_number))!;
}

// ---------- deciding ----------

/**
 * A reviewer who isn't the proposer decides: approve (the bot merges the pull request and starts the release),
 * send it back with what to change, or turn it down (the pull request is closed). The proposer hears either way.
 */
export async function reviewProposal(env: Env, actor: User, t: Wrapper, p: ProposalRow, decision: Decision, noteIn: unknown): Promise<ProposalRow> {
  if (!(await communityRoles(env, actor)).has("reviewer")) apiError(403, "not_reviewer", "only staff and community reviewers can decide change proposals");
  if (p.proposer_id === actor.id) apiError(403, "self_review", "someone other than the proposer has to review a change proposal");
  if (!(DECISIONS as readonly string[]).includes(decision)) apiError(400, "invalid_body", `decision must be one of: ${DECISIONS.join(", ")}`);
  if (decision === "changes_requested" ? p.status !== "open" : !OPEN_STATUSES.includes(p.status)) apiError(409, "proposal_closed", `proposal #${p.pr_number} is ${p.status.replace("_", " ")}`);
  const note = typeof noteIn === "string" ? plain(noteIn, MAX_NOTE) : "";
  if (decision !== "approve" && !note) apiError(400, "invalid_body", "say what needs to change, or why it is turned down, in {note}");
  const token = await botToken(env);
  let released: string | null = null;
  if (decision === "approve") {
    const taken = !!(await env.DB.prepare(`SELECT 1 FROM versions WHERE tool_id = ? AND version = ?`).bind(t.id, p.version).first());
    // A tag releases the manifest's own version, so it must still be free; the release workflow takes any version.
    if (taken && !p.builds) apiError(409, "version_taken", `${refOf(t)} ${p.version} was released meanwhile`, "the proposer saves the proposal again to move it to the next version");
    released = taken ? (await nextVersion(env, t.id)).next : p.version;
    const sha = await github.mergePull(deps.fetch, token, t.wrapper, p.pr_number, `${p.title} (#${p.pr_number})`).catch((e) => {
      if (e instanceof HostError) apiError(409, "proposal_not_mergeable", `GitHub won't merge #${p.pr_number}: ${e.message}`, "the proposer saves the proposal again to rebuild it on the newest files");
      throw e;
    });
    if (p.builds) await github.dispatchWorkflow(deps.fetch, token, t.wrapper, WORKFLOW, "main", { version: released }).catch(hostFailed);
    else await github.createTag(deps.fetch, token, t.wrapper, `v${released}`, sha).catch(hostFailed);
  } else if (decision === "reject") {
    await github.closePull(deps.fetch, token, t.wrapper, p.pr_number).catch((e) => console.error("closing the proposal's pull request failed", e));
  }
  const status: ProposalStatus = decision === "approve" ? "merged" : decision === "reject" ? "rejected" : "changes_requested";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE change_proposals SET status = ?, reviewer_id = ?, decision_note = ?, decided_at = ?, released_version = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, actor.id, note || null, now, released, now, p.id),
    audit(env.DB, actor.id, "user", `proposal.${decision === "approve" ? "merge" : decision === "reject" ? "reject" : "request_changes"}`, "tool", t.id, { pr: p.pr_number, released }),
  ]);
  const words = { approve: `was merged; ${refOf(t)} ${released} is being built and scanned`, changes_requested: "needs changes", reject: "was turned down" };
  if (p.proposer_id) {
    await notify(env, [p.proposer_id], {
      kind: "proposal", scope: "community", path: `/${refOf(t)}/changes/${p.pr_number}`, tool_id: t.id, actor_id: actor.id,
      summary: `Your change to ${refOf(t)} (#${p.pr_number}) ${words[decision]}`,
    });
  }
  return (await proposalByNumber(env, t.id, p.pr_number))!;
}

/** The proposer (or an admin) withdraws a proposal; its pull request is closed. */
export async function withdrawProposal(env: Env, user: User, t: Wrapper, p: ProposalRow) {
  if (p.proposer_id !== user.id && !user.is_admin) apiError(403, "forbidden", "only the person who proposed a change can withdraw it");
  if (!OPEN_STATUSES.includes(p.status)) apiError(409, "proposal_closed", `proposal #${p.pr_number} is ${p.status.replace("_", " ")}`);
  const token = await botToken(env);
  await github.closePull(deps.fetch, token, t.wrapper, p.pr_number).catch((e) => console.error("closing the proposal's pull request failed", e));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE change_proposals SET status = 'withdrawn', updated_at = ? WHERE id = ?`).bind(now, p.id),
    audit(env.DB, user.id, "user", "proposal.withdraw", "tool", t.id, { pr: p.pr_number }),
  ]);
}
