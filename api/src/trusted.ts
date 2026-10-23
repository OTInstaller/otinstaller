// Trusted publishing: the GitHub Actions workflows and GitLab CI pipelines a namespace's owners trust to publish into
// it without the GitHub App or a connected GitLab project. A run trades its OIDC ID token (checked in lib/oidc.ts) for
// an hour-long ot_ token restricted to the namespace (lib/tokens.ts), then uploads its release as `ot publish` does
// (direct.ts); the publish job names the repository the ID token proved, which owns the package's name as a tag does.
// Routes are in routes/trusted.ts.
import { deps, type Env, type User } from "./env";
import { apiError, rateLimited, windowRetry } from "./lib/errors";
import { randomToken, sha256Hex, ulid } from "./lib/crypto";
import { verifyCiToken, type CiClaims } from "./lib/oidc";
import { TOKEN_PREFIX, type Restriction } from "./lib/tokens";
import { overLimit } from "./trust";
import { audit } from "./routes/auth";

/** How long a CI run's token lasts: long enough for `ot publish --wait` and a large image push. */
export const CI_TOKEN_TTL = 3600_000;
// Expired CI tokens are kept this long, so the ID tokens they came from stay known as used (api_tokens.jti) for longer
// than any of them can be valid (lib/oidc.ts refuses ID tokens valid for more than a day).
export const CI_TOKEN_RETENTION = 2 * 86_400_000;
export const MAX_PUBLISHERS = 20;
const EXCHANGES_PER_HOUR = 30;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const REPOSITORY = { github: /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/, gitlab: /^[a-z0-9_.-]+(\/[a-z0-9_.-]+){1,19}$/ };
const WORKFLOW = { github: /^[A-Za-z0-9._-]{1,100}\.ya?ml$/, gitlab: /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,254}\.ya?ml$/ };
// Events that can run a workflow with code from outside the repository's own branches. They may publish only through a
// publisher that requires an environment, whose protection rules the repository's owners set.
const RISKY_EVENTS = new Set(["pull_request_target", "merge_request_event"]);

export type TrustedPublisher = {
  id: string;
  namespace_id: string;
  provider: "github" | "gitlab";
  repository: string;
  repository_id: string | null;
  owner_id: string | null;
  workflow: string | null;
  environment: string | null;
  package: string | null;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
};

type Ns = { id: string; name: string; status: string };

/** A publisher as owners see it. `pinned` says the repository's id is recorded (it has published at least once). */
export function publisherView(p: TrustedPublisher & { created_by_login?: string | null }) {
  return {
    id: p.id, provider: p.provider, repository: p.repository, workflow: p.workflow, environment: p.environment, package: p.package,
    pinned: p.repository_id !== null, created_by: p.created_by_login ?? null, created_at: p.created_at, last_used_at: p.last_used_at,
  };
}

export async function listPublishers(env: Env, nsId: string) {
  const rows = await env.DB.prepare(
    `SELECT p.*, u.login AS created_by_login FROM trusted_publishers p LEFT JOIN users u ON u.id = p.created_by WHERE p.namespace_id = ? ORDER BY p.created_at`,
  ).bind(nsId).all<TrustedPublisher & { created_by_login: string | null }>();
  return rows.results.map(publisherView);
}

const optional = (v: unknown) => (v === undefined || v === null || v === "" ? null : v);

/** Trusts a repository (and optionally one workflow, environment or package) to publish into a namespace. */
export async function addPublisher(env: Env, user: User, ns: Ns, body: Record<string, unknown>) {
  const provider = body.provider;
  if (provider !== "github" && provider !== "gitlab") apiError(400, "invalid_body", "send {provider: github or gitlab, repository, workflow?, environment?, package?}");
  const repository = typeof body.repository === "string" ? body.repository.trim().replace(/^\/+|\/+$/g, "").toLowerCase() : "";
  if (!REPOSITORY[provider].test(repository)) {
    apiError(400, "invalid_body", provider === "github" ? "repository is owner/name, as in github.com/owner/name" : "repository is the project's path, as in gitlab.com/group/project");
  }
  let workflow = optional(body.workflow);
  if (workflow !== null) {
    if (typeof workflow !== "string") apiError(400, "invalid_body", "workflow is a file name");
    workflow = provider === "github" ? workflow.trim().replace(/^\.github\/workflows\//, "") : workflow.trim();
    if (!WORKFLOW[provider].test(workflow as string)) {
      apiError(400, "invalid_body", provider === "github" ? "workflow is a file in .github/workflows, such as release.yml" : "workflow is the CI configuration's path, such as .gitlab-ci.yml");
    }
  }
  const environment = optional(body.environment);
  if (environment !== null && (typeof environment !== "string" || !/^[^\u0000-\u001f]{1,255}$/.test(environment.trim()))) {
    apiError(400, "invalid_body", "environment is a deployment environment's name");
  }
  const pkg = optional(body.package);
  if (pkg !== null && (typeof pkg !== "string" || !SLUG.test(pkg))) apiError(400, "invalid_body", "package is a package name in this namespace");

  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM trusted_publishers WHERE namespace_id = ?`).bind(ns.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PUBLISHERS) {
    apiError(403, "trusted_publisher_limit", `${ns.name} trusts ${MAX_PUBLISHERS} publishers, the most a namespace can`, "remove one you no longer use");
  }
  const envName = environment === null ? null : (environment as string).trim();
  const dupe = await env.DB.prepare(
    `SELECT id FROM trusted_publishers WHERE namespace_id = ? AND provider = ? AND repository = ? AND workflow IS ? AND environment IS ? AND package IS ?`,
  ).bind(ns.id, provider, repository, workflow, envName, pkg).first<{ id: string }>();
  if (dupe) apiError(409, "trusted_publisher_exists", `${ns.name} already trusts this publisher (${dupe.id})`);

  const p: TrustedPublisher = {
    id: ulid(), namespace_id: ns.id, provider, repository, repository_id: null, owner_id: null, workflow: workflow as string | null,
    environment: envName, package: pkg as string | null, created_by: user.id, created_at: Date.now(), last_used_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trusted_publishers (id, namespace_id, provider, repository, workflow, environment, package, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(p.id, p.namespace_id, p.provider, p.repository, p.workflow, p.environment, p.package, p.created_by, p.created_at),
    audit(env.DB, user.id, "user", "trusted_publisher.add", "namespace", ns.id, { id: p.id, provider, repository, workflow, environment: envName, package: pkg }),
  ]);
  return publisherView({ ...p, created_by_login: user.login });
}

/** Stops trusting a publisher. Tokens its runs still hold stop working at once. */
export async function removePublisher(env: Env, user: User, ns: Ns, id: string) {
  const p = await env.DB.prepare(`SELECT * FROM trusted_publishers WHERE id = ? AND namespace_id = ?`).bind(id, ns.id).first<TrustedPublisher>();
  if (!p) apiError(404, "not_found", `${ns.name} has no trusted publisher ${id}`);
  await env.DB.batch([
    env.DB.prepare(`UPDATE api_tokens SET revoked_at = ? WHERE trusted_publisher_id = ? AND revoked_at IS NULL`).bind(Date.now(), id),
    env.DB.prepare(`DELETE FROM trusted_publishers WHERE id = ?`).bind(id),
    audit(env.DB, user.id, "user", "trusted_publisher.remove", "namespace", ns.id, { id, provider: p.provider, repository: p.repository }),
  ]);
}

const notTrusted = (message: string, hint?: string): never => apiError(403, "publisher_not_trusted", message, hint);

/** Why a publisher doesn't cover this run, or null when it does. */
function mismatch(p: TrustedPublisher, c: CiClaims, pkg: string | null): string | null {
  if (p.repository_id && p.repository_id !== c.repositoryId) return `${c.repository} is not the repository that first published through it (its id changed)`;
  if (p.owner_id && p.owner_id !== c.ownerId) return `${c.repository} has a different owner than when it first published`;
  if (p.workflow && p.workflow !== c.workflow) return `the run's workflow is ${c.workflow}, not ${p.workflow}`;
  if (p.environment && p.environment.toLowerCase() !== (c.environment ?? "").toLowerCase()) {
    return c.environment ? `the job's environment is ${c.environment}, not ${p.environment}` : `the job must run in the ${p.environment} environment`;
  }
  if (!p.environment && RISKY_EVENTS.has(c.event)) return `a run triggered by ${c.event} can publish only through a publisher that requires an environment`;
  if (p.package && pkg && p.package !== pkg) return `it publishes ${p.package} only, not ${pkg}`;
  return null;
}

/** The publisher in a namespace that trusts this run, and the package the run's token is limited to. */
export async function matchPublisher(env: Env, ns: Ns, c: CiClaims, pkg: string | null): Promise<{ publisher: TrustedPublisher; pkg: string | null }> {
  const rows = await env.DB.prepare(
    `SELECT * FROM trusted_publishers WHERE provider = ? AND repository = ? AND namespace_id = ? ORDER BY created_at`,
  ).bind(c.provider, c.repository.toLowerCase(), ns.id).all<TrustedPublisher>();
  const why: string[] = [];
  for (const p of rows.results) {
    const miss = mismatch(p, c, pkg);
    if (!miss) return { publisher: p, pkg: pkg ?? p.package };
    why.push(miss);
  }
  const who = `${c.provider}:${c.repository}`;
  return rows.results.length
    ? notTrusted(`${ns.name} trusts ${who}, but ${why[0]}`, "an owner can see the namespace's trusted publishers with `ot namespace trusted " + ns.name + "`")
    : notTrusted(`${ns.name} does not trust ${who} to publish`, `an owner of ${ns.name} can add it: \`ot namespace trust ${ns.name} ${who}\``);
}

/**
 * Trades a CI run's ID token for an hour-long ot_ token that publishes into one namespace (and package), acting for
 * the owner who added the trusted publisher. Each ID token is exchanged once.
 */
export async function exchangeIdToken(env: Env, body: { id_token?: unknown; namespace?: unknown; package?: unknown }) {
  if (typeof body.id_token !== "string" || typeof body.namespace !== "string") apiError(400, "invalid_body", "send {id_token, namespace, package?}");
  const pkgReq = optional(body.package);
  if (pkgReq !== null && (typeof pkgReq !== "string" || !SLUG.test(pkgReq))) apiError(400, "invalid_body", "package is a package name");
  const c = await verifyCiToken(deps.fetch, body.id_token);
  if (await overLimit(env, "oidc_token", `${c.provider}:${c.repositoryId}`, EXCHANGES_PER_HOUR, 3600_000)) {
    rateLimited("too_many_requests", `at most ${EXCHANGES_PER_HOUR} token exchanges an hour per repository`, "wait and run the workflow again", windowRetry(3600_000), EXCHANGES_PER_HOUR, 3600);
  }
  const ns = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE name = ?`).bind(body.namespace).first<Ns>();
  if (!ns) apiError(404, "namespace_unknown", `${body.namespace} is not a namespace on the registry`, "check `namespace:` in otinstaller.yaml");
  if (ns.status === "rejected" || ns.status === "suspended") apiError(403, "namespace_not_allowed", `namespace ${ns.name} is ${ns.status} and cannot publish`, "contact abuse@otinstaller.com");
  // The registry is public, and so are its packages' pages, links and backups.
  if (c.visibility !== "public") {
    notTrusted(`${c.provider}:${c.repository} is ${c.visibility || "not public"}; only public repositories can publish`, "make the repository public, or publish with `ot publish` from your machine");
  }
  const { publisher: p, pkg } = await matchPublisher(env, ns, c, pkgReq as string | null);
  // The token acts for the owner who added the publisher, so it stops working once they leave or are banned.
  const creator = await env.DB.prepare(
    `SELECT u.id, u.login FROM namespace_members m JOIN users u ON u.id = m.user_id WHERE m.namespace_id = ? AND m.user_id = ? AND u.banned_at IS NULL`,
  ).bind(ns.id, p.created_by).first<{ id: string; login: string }>();
  if (!creator) notTrusted(`the owner who added this trusted publisher is no longer in ${ns.name}`, `an owner of ${ns.name} must add it again`);

  const now = Date.now();
  const token = TOKEN_PREFIX + randomToken(30);
  const id = ulid(now);
  const expiresAt = now + CI_TOKEN_TTL;
  const ci: NonNullable<Restriction["ci"]> = {
    provider: c.provider, repository: c.repository, repository_id: c.repositoryId, ref: c.ref, ref_type: c.refType, sha: c.sha, workflow: c.workflow, run: c.run,
  };
  const oidc = { ...ci, environment: c.environment, event: c.event, actor: c.actor };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, scoped, expires_at, created_at, namespace_id, package, trusted_publisher_id, oidc_json, jti)
         VALUES (?, ?, ?, ?, 'read,publish', 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, creator!.id, `ci ${c.provider}:${c.repository}`.slice(0, 60), await sha256Hex(token), expiresAt, now, ns.id, pkg, p.id, JSON.stringify(oidc), c.jti),
      // The first run pins the repository's and its owner's ids.
      env.DB.prepare(`UPDATE trusted_publishers SET repository_id = COALESCE(repository_id, ?), owner_id = COALESCE(owner_id, ?), last_used_at = ? WHERE id = ?`)
        .bind(c.repositoryId, c.ownerId || null, now, p.id),
      audit(env.DB, creator!.id, c.provider, "token.create_ci", "token", id, { namespace: ns.name, package: pkg, publisher: p.id, ...oidc }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) apiError(401, "oidc_token_reused", "this ID token was already exchanged", "each ID token works once: run the job again for a new one");
    throw e;
  }
  return { token, expires_at: expiresAt, namespace: ns.name, package: pkg, repository: `${c.provider}:${c.repository}`, workflow: c.workflow };
}

/** Deletes CI tokens that expired long enough ago that the ID tokens they came from can no longer be valid. */
export async function purgeCiTokens(env: Env, now = Date.now()) {
  const r = await env.DB.prepare(`DELETE FROM api_tokens WHERE namespace_id IS NOT NULL AND expires_at < ?`).bind(now - CI_TOKEN_RETENTION).run();
  return r.meta.changes ?? 0;
}
