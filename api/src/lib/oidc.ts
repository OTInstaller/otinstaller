// OpenID Connect plumbing shared by every issuer the registry trusts: discovery documents and signing keys, cached per
// issuer, and ID-token signature checks (EdDSA for OSINTverse sign-ins in hosts/osintverse.ts, RS256 for GitHub
// Actions and GitLab CI). verifyCiToken checks a CI run's ID token for trusted publishing (trusted.ts); what a
// sign-in's claims must say stays in hosts/osintverse.ts.
import { HostError, type Fetch } from "../hosts/github";
import { apiError } from "./errors";

export interface Discovery {
  issuer: string;
  jwks_uri: string;
}

export interface Jwk { kty: string; kid?: string; alg?: string; use?: string; crv?: string; x?: string; n?: string; e?: string }

// Per isolate and per issuer: discovery and keys change rarely, so they are cached for an hour (keys are fetched
// again at once when a token names a key we don't have).
const TTL = 3600_000;
const discoveries = new Map<string, { at: number; value: Discovery }>();
const keySets = new Map<string, { at: number; keys: Jwk[] }>();

/** Clears the caches (tests use different fake providers). */
export function resetOidcCaches() {
  discoveries.clear();
  keySets.clear();
}

export async function check(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new HostError(`${what} failed: ${res.status} ${body.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
}

/** An issuer's discovery document, which must name the issuer itself. `label` names the provider in errors. */
export async function discover<T extends Discovery>(f: Fetch, issuer: string, label: string): Promise<T> {
  const hit = discoveries.get(issuer);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const d = (await (await check(await f(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } }), `${label} discovery`)).json()) as T;
  if (d.issuer !== issuer) throw new HostError(`${label} discovery names issuer ${d.issuer}, expected ${issuer}`, 502, false);
  discoveries.set(issuer, { at: Date.now(), value: d });
  return d;
}

async function keys(f: Fetch, uri: string, refresh: boolean, label: string): Promise<Jwk[]> {
  const hit = keySets.get(uri);
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.keys;
  const body = (await (await check(await f(uri, { headers: { Accept: "application/json" } }), `${label} JWKS`)).json()) as { keys?: Jwk[] };
  const found = body.keys ?? [];
  keySets.set(uri, { at: Date.now(), keys: found });
  return found;
}

export function fromB64url(part: string): Uint8Array {
  const s = atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(fromB64url(part))) as T;
}

export type Alg = "EdDSA" | "RS256";

const ALGS: Record<Alg, { fits: (k: Jwk) => boolean; key: (k: Jwk) => Promise<CryptoKey>; params: { name: string } }> = {
  EdDSA: {
    fits: (k) => k.kty === "OKP" && k.crv === "Ed25519" && !!k.x,
    key: (k) => crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]),
    params: { name: "Ed25519" },
  },
  RS256: {
    fits: (k) => k.kty === "RSA" && !!k.n && !!k.e && (!k.alg || k.alg === "RS256"),
    key: (k) => crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    params: { name: "RSASSA-PKCS1-v1_5" },
  },
};

/**
 * Checks a JWT's signature against its issuer's published keys and returns its claims, which the caller still has to
 * check. A malformed token, an algorithm outside `algs` or an unknown key throw a HostError with `status` (502 when the
 * provider itself handed the token over, 401 when a client sent it); a bad signature always throws 401.
 */
export async function verifySignature<T>(f: Fetch, d: Discovery, token: string, o: { algs: readonly Alg[]; label: string; status: number }): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HostError(`the ${o.label} ID token is malformed`, o.status, false);
  let header: { alg?: string; kid?: string };
  try {
    header = decodePart(parts[0]!);
  } catch {
    throw new HostError(`the ${o.label} ID token is malformed`, o.status, false);
  }
  const alg = header.alg as Alg;
  if (!o.algs.includes(alg)) throw new HostError(`the ${o.label} ID token uses ${header.alg}, not ${o.algs.join(" or ")}`, o.status, false);
  const spec = ALGS[alg];
  const find = (ks: Jwk[]) => ks.find((k) => spec.fits(k) && (!header.kid || k.kid === header.kid));
  const jwk = find(await keys(f, d.jwks_uri, false, o.label)) ?? find(await keys(f, d.jwks_uri, true, o.label));
  if (!jwk) throw new HostError(`no ${o.label} signing key matches the ID token`, o.status, false);
  const ok = await crypto.subtle.verify(spec.params, await spec.key(jwk), fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HostError(`the ${o.label} ID token signature is invalid`, 401, false);
  try {
    return decodePart<T>(parts[1]!);
  } catch {
    throw new HostError(`the ${o.label} ID token is malformed`, o.status, false);
  }
}

// ---------- CI ID tokens (trusted publishing) ----------

export const CI_ISSUERS = { github: "https://token.actions.githubusercontent.com", gitlab: "https://gitlab.com" } as const;
/** The audience a CI run must ask its ID token for: `ot publish --oidc` asks GitHub for it, GitLab's id_tokens names it. */
export const CI_AUDIENCE = "otinstaller";
// An ID token valid for longer than this is refused: used ID tokens are remembered (api_tokens.jti) only a little
// longer than that, so a token that outlived the memory of its use could be exchanged again.
export const MAX_CI_TOKEN_LIFETIME_S = 86_400;

/** Where a CI run ran, read from its ID token: the same shape for GitHub Actions and GitLab CI. */
export interface CiClaims {
  provider: "github" | "gitlab";
  /** owner/name on GitHub, group/project on GitLab, as the host spells it. */
  repository: string;
  repositoryId: string;
  /** The repository owner's id on GitHub, the project's namespace id on GitLab. */
  ownerId: string;
  /** public, private or internal. */
  visibility: string;
  /** A full ref: refs/heads/main or refs/tags/v1.2.0. */
  ref: string;
  refType: string;
  sha: string;
  /** The workflow file (release.yml) on GitHub, the CI configuration's path (.gitlab-ci.yml) on GitLab. */
  workflow: string;
  environment: string | null;
  /** GitHub's event_name or GitLab's pipeline_source. */
  event: string;
  run: string;
  actor: string;
  jti: string;
  exp: number;
}

const invalid = (message: string, hint?: string): never => apiError(401, "oidc_token_invalid", message, hint);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

type GithubClaims = Record<string, unknown> & {
  repository?: string; repository_id?: string; repository_owner_id?: string; repository_visibility?: string; ref?: string; ref_type?: string;
  sha?: string; job_workflow_ref?: string; environment?: string; event_name?: string; run_id?: string; run_attempt?: string; actor?: string;
};
type GitlabClaims = Record<string, unknown> & {
  project_path?: string; project_id?: string; namespace_id?: string; project_visibility?: string; ref?: string; ref_type?: string; ref_path?: string;
  sha?: string; ci_config_ref_uri?: string; environment?: string; pipeline_source?: string; pipeline_id?: string; job_id?: string; user_login?: string;
};

/** The file a workflow reference names, when it lives in the repository itself (`<prefix><file>@<ref>`). */
function workflowIn(ref: string, prefix: string): string | null {
  if (!ref.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const file = ref.slice(prefix.length).split("@")[0] ?? "";
  return file || null;
}

function githubClaims(c: GithubClaims): Omit<CiClaims, "jti" | "exp"> {
  const repository = str(c.repository);
  if (!repository || !str(c.repository_id)) invalid("the GitHub ID token names no repository");
  // A job can run a reusable workflow from another repository; only the repository's own workflows may publish it,
  // as only they sign its images with the identity the scanner expects.
  const workflow = workflowIn(str(c.job_workflow_ref), `${repository}/.github/workflows/`);
  if (!workflow) {
    invalid(`the job runs ${str(c.job_workflow_ref) || "a workflow"} from outside ${repository}`, "publish from a workflow in the repository itself");
  }
  return {
    provider: "github", repository, repositoryId: str(c.repository_id), ownerId: str(c.repository_owner_id), visibility: str(c.repository_visibility),
    ref: str(c.ref), refType: str(c.ref_type), sha: str(c.sha), workflow: workflow!, environment: str(c.environment) || null,
    event: str(c.event_name), run: [str(c.run_id), str(c.run_attempt)].filter(Boolean).join("/"), actor: str(c.actor),
  };
}

function gitlabClaims(c: GitlabClaims): Omit<CiClaims, "jti" | "exp"> {
  const repository = str(c.project_path);
  if (!repository || !str(c.project_id)) invalid("the GitLab ID token names no project");
  // The pipeline's configuration can come from another project; only the project's own may publish it.
  const workflow = workflowIn(str(c.ci_config_ref_uri), `gitlab.com/${repository}//`);
  if (!workflow) {
    invalid(`the pipeline runs ${str(c.ci_config_ref_uri) || "a CI configuration"} from outside ${repository}`, "publish from the project's own CI configuration");
  }
  const refType = str(c.ref_type);
  const ref = str(c.ref_path) || (refType === "tag" ? `refs/tags/${str(c.ref)}` : `refs/heads/${str(c.ref)}`);
  return {
    provider: "gitlab", repository, repositoryId: str(c.project_id), ownerId: str(c.namespace_id), visibility: str(c.project_visibility),
    ref, refType, sha: str(c.sha), workflow: workflow!, environment: str(c.environment) || null,
    event: str(c.pipeline_source), run: [str(c.pipeline_id), str(c.job_id)].filter(Boolean).join("/"), actor: str(c.user_login),
  };
}

/**
 * Verifies an ID token from GitHub Actions or GitLab CI: an RS256 signature by the issuer's published keys, the
 * otinstaller audience, and its time claims (60 s leeway). Returns where the run ran; whether that may publish is
 * trusted.ts's question. Anything wrong with the token itself is a 401 oidc_token_invalid.
 */
export async function verifyCiToken(f: Fetch, token: string, now = Date.now()): Promise<CiClaims> {
  if (typeof token !== "string" || token.split(".").length !== 3) invalid("send an ID token from GitHub Actions or GitLab CI");
  let iss: unknown;
  try {
    iss = decodePart<{ iss?: unknown }>(token.split(".")[1]!).iss;
  } catch {
    invalid("the ID token is malformed");
  }
  const provider = (Object.keys(CI_ISSUERS) as (keyof typeof CI_ISSUERS)[]).find((p) => CI_ISSUERS[p] === iss);
  if (!provider) invalid(`ID tokens from ${String(iss)} are not accepted`, "publish from GitHub Actions or GitLab.com CI");
  const label = provider === "github" ? "GitHub" : "GitLab";
  let c: Record<string, unknown>;
  try {
    const d = await discover<Discovery>(f, CI_ISSUERS[provider!], label);
    c = await verifySignature<Record<string, unknown>>(f, d, token, { algs: ["RS256"], label, status: 401 });
  } catch (e) {
    // Anything about the token itself is the caller's to fix; a provider that can't be reached is worth a retry.
    if (e instanceof HostError && e.status === 401) invalid(e.message);
    if (e instanceof HostError) apiError(503, "oidc_provider_unavailable", `could not check the ID token with ${label}: ${e.message}`, "try again in a minute");
    throw e;
  }
  const t = Math.floor(now / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  const num = (v: unknown) => (typeof v === "number" ? v : NaN);
  const problems = [
    c.iss !== CI_ISSUERS[provider!] && "issuer",
    !aud.includes(CI_AUDIENCE) && "audience",
    !(num(c.exp) + 60 > t) && "expiry",
    typeof c.nbf === "number" && c.nbf - 60 > t && "not-before",
    !(num(c.iat) - 60 <= t) && "issued-at",
    !(num(c.exp) - num(c.iat) <= MAX_CI_TOKEN_LIFETIME_S) && "lifetime",
    !str(c.jti) && "token id",
  ].filter(Boolean);
  if (problems.length) {
    invalid(`the ${label} ID token failed its ${problems.join(", ")} check`, aud.includes(CI_AUDIENCE) ? undefined : `ask for an ID token with the audience ${CI_AUDIENCE}`);
  }
  const claims = provider === "github" ? githubClaims(c as GithubClaims) : gitlabClaims(c as GitlabClaims);
  return { ...claims, jti: `${provider}:${str(c.jti)}`, exp: num(c.exp) };
}
