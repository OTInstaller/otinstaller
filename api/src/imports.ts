// The import wizard: looks at a GitHub or GitLab repository, drafts its otinstaller.yaml, and finishes by
// opening a pull/merge request with the manifest and release workflow, or by keeping the manifest on the
// registry. Bulk imports detect in the queue, one message per repository.
import YAML from "yaml";
import schema from "../../spec/schema/v1.json";
import { deps, requireSecret, type Env, type User } from "./env";
import { apiError } from "./lib/errors";
import { ulid } from "./lib/crypto";
import { parseManifest, semverParts, type Manifest, type Problem } from "./lib/manifest";
import * as github from "./hosts/github";
import * as gitlab from "./hosts/gitlab";
import { HostError, type DirEntry, type FileChange } from "./hosts/github";
import { githubUserToken, gitlabToken, repoUrl } from "./hosts/repo";
import { imageDigest, pypiRelease } from "./hosts/artifacts";
import { RELEASE_TAG, queueTag, sourceById, sourceByProject } from "./sync";
import { audit } from "./routes/auth";
import { connectGitlabProject, gitlabNamespaceName } from "./routes/sources";
import { RELEASE_TEMPLATES } from "./release-templates";
import { dailyLimit } from "./community";
import { RESERVED_NAMESPACES } from "./lib/reserved";

export const MAX_BULK = 50;
export const IMPORT_BRANCH = "otinstaller/import";
const MANIFEST_FILE = "otinstaller.yaml";
export const ZERO = "0".repeat(64);

export type Provider = "github" | "gitlab";
export type Kind = "docker" | "pipx" | "guide";
export type FinishMode = "pr" | "registry" | "connect" | "wrapper";

/** Wrappers of other people's tools live here, labelled Community-packaged with credit to the upstream project. */
export const COMMUNITY_NAMESPACE = "osintverse-community";

// Licenses that allow publishing a wrapper of someone else's tool.
const REDISTRIBUTABLE = /^(MIT|MIT-0|Apache-2\.0|BSD-[234]-Clause|0BSD|ISC|MPL-2\.0|(A|L)?GPL-[23]\.0(-only|-or-later)?|LGPL-2\.1(-only|-or-later)?|Unlicense|CC0-1\.0|CC-BY(-SA)?-4\.0|EPL-2\.0|EUPL-1\.2|Zlib|Artistic-2\.0|BSL-1\.0)$/i;

/** Whether a license lets the registry redistribute a tool as a community wrapper (and so take requests for it). SPDX ids match whatever their case (GitLab's are lowercase). */
export const isRedistributable = (license: string | null | undefined): boolean => !!license && REDISTRIBUTABLE.test(license);

/** A refusal that the routes turn into an API error and bulk detection records on the import. */
export class ImportProblem extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string, readonly hint?: string) {
    super(message);
  }
}

const refuse = (status: ImportProblem["status"], code: string, message: string, hint?: string): never => {
  throw new ImportProblem(status, code, message, hint);
};

/** What detection found. Kept with the import so the draft can be rebuilt for another kind. */
export interface Facts {
  provider: Provider;
  path: string;
  url: string;
  defaultBranch: string;
  namespace: string;
  repoName: string;
  description: string | null;
  topics: string[];
  license: string | null;
  readme: string | null;
  signals: string[];
  kind: Kind | null;
  existingManifest: boolean;
  latestTag: string | null;
  image: { ref: string; digest: string | null; platforms: string[] } | null;
  pypi: { package: string; entrypoint: string | null; version: string | null; wheelSha256: string | null } | null;
  docs: { root: string; nav: string[] } | null;
  hasGitlabCi: boolean;
  canHoldManifest: boolean;
  appInstalled: boolean;
  /** A community wrapper of this (upstream) repository. */
  community?: boolean;
}

// ---------- detection (pure) ----------

const CATEGORIES: string[] = schema.$defs.category.enum;
const INPUT_TYPES: string[] = schema.$defs.inputType.enum;
const PARAMETER_TYPES = new Set(["string", "integer", "boolean", "enum"]);

// Common repository topics that name a registry category.
const TOPIC_CATEGORIES: Record<string, string> = {
  emails: "email", usernames: "username", "phone-number": "phone", "phone-numbers": "phone",
  dns: "domain-dns", domain: "domain-dns", domains: "domain-dns", whois: "domain-dns", subdomains: "domain-dns",
  ip: "ip-network", network: "ip-network", networking: "ip-network",
  social: "social-media", socmint: "social-media", "social-network": "social-media", twitter: "social-media", instagram: "social-media",
  person: "people", "people-search": "people", business: "company", companies: "company",
  geoint: "images-geo", geolocation: "images-geo", imint: "images-geo", images: "images-geo", image: "images-geo",
  blockchain: "crypto", bitcoin: "crypto", ethereum: "crypto", cryptocurrency: "crypto",
  breach: "breach-data", breaches: "breach-data", leaks: "breach-data", "data-breach": "breach-data",
  archive: "web-archive", wayback: "web-archive", "wayback-machine": "web-archive",
  metadata: "documents-metadata", exif: "documents-metadata", documents: "documents-metadata",
};

export function categoriesFrom(topics: string[]): string[] {
  const out = new Set<string>();
  for (const t of topics.map((x) => x.toLowerCase())) {
    const c = CATEGORIES.includes(t) ? t : TOPIC_CATEGORIES[t];
    if (c) out.add(c);
  }
  return [...out].slice(0, 3);
}

// GitLab reports license keys; the manifest wants SPDX identifiers.
const GITLAB_LICENSES: Record<string, string> = {
  mit: "MIT", "apache-2.0": "Apache-2.0", "gpl-2.0": "GPL-2.0-only", "gpl-3.0": "GPL-3.0-only", "agpl-3.0": "AGPL-3.0-only",
  "lgpl-2.1": "LGPL-2.1-only", "lgpl-3.0": "LGPL-3.0-only", "bsd-2-clause": "BSD-2-Clause", "bsd-3-clause": "BSD-3-Clause",
  "mpl-2.0": "MPL-2.0", unlicense: "Unlicense", isc: "ISC", "cc0-1.0": "CC0-1.0", "cc-by-4.0": "CC-BY-4.0", "epl-2.0": "EPL-2.0",
};

const LICENSE_TEXTS: [RegExp, string][] = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, "AGPL-3.0-only"],
  [/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i, "LGPL-3.0-only"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, "GPL-3.0-only"],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, "GPL-2.0-only"],
  [/Apache License,?\s+Version 2\.0/i, "Apache-2.0"],
  [/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i, "MPL-2.0"],
  [/This is free and unencumbered software released into the public domain/i, "Unlicense"],
  [/\bISC License\b/i, "ISC"],
  [/\bMIT License\b|Permission is hereby granted, free of charge/i, "MIT"],
  [/Neither the name of/i, "BSD-3-Clause"],
  [/Redistributions in binary form must reproduce/i, "BSD-2-Clause"],
];

export function licenseFromText(text: string): string | null {
  return LICENSE_TEXTS.find(([re]) => re.test(text))?.[1] ?? null;
}

export function gitlabLicense(key: string | undefined | null): string | null {
  if (!key) return null;
  return GITLAB_LICENSES[key.toLowerCase()] ?? null;
}

/** The [project] name and console scripts of a pyproject.toml (PEP 621 or Poetry), without a TOML parser. */
export function pyprojectInfo(text: string): { name: string | null; scripts: string[] } {
  let section = "";
  let name: string | null = null;
  const scripts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const kv = /^(["']?)([A-Za-z0-9_.-]+)\1\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[2]!, value = kv[3]!.trim().replace(/^["']|["']$/g, "");
    if ((section === "project" || section === "tool.poetry") && key === "name" && !name) name = value;
    if (section === "project.scripts" || section === "tool.poetry.scripts") scripts.push(key);
  }
  return { name, scripts };
}

/** The [metadata] name and console scripts of a setuptools setup.cfg ([options.entry_points] console_scripts). */
export function setupCfgInfo(text: string): { name: string | null; scripts: string[] } {
  let section = "";
  let name: string | null = null;
  let inScripts = false;
  const scripts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+[#;].*$/, "");
    const sec = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (sec && !/^\s/.test(line)) {
      section = sec[1]!.trim();
      inScripts = false;
      continue;
    }
    if (!line.trim()) continue;
    // console_scripts = followed by indented "name = module:function" lines (the first may sit on the same line).
    const kv = /^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      inScripts = section === "options.entry_points" && kv[1] === "console_scripts";
      if (section === "metadata" && kv[1] === "name" && !name) name = kv[2]!.trim() || null;
      const first = inScripts ? /^([A-Za-z0-9_.-]+)\s*=/.exec(kv[2]!.trim()) : null;
      if (first) scripts.push(first[1]!);
      continue;
    }
    const entry = inScripts ? /^\s+([A-Za-z0-9_.-]+)\s*=/.exec(line) : null;
    if (entry) scripts.push(entry[1]!);
  }
  return { name, scripts };
}

const IGNORED_FILE = /^(\.|license|licence|copying|notice|authors|contributing|code_of_conduct|security|changelog)/i;

/** The plan's detection order: a Dockerfile, a console script (pyproject.toml or setup.cfg), then docs or Markdown only. */
export function detectKind(root: DirEntry[], pyproject: { scripts: string[]; from?: string } | null): { kind: Kind | null; signals: string[] } {
  const files = root.filter((e) => e.type === "file").map((e) => e.name);
  const dirs = root.filter((e) => e.type === "dir").map((e) => e.name);
  if (files.includes("Dockerfile")) return { kind: "docker", signals: ["Dockerfile"] };
  if (pyproject?.scripts.length) return { kind: "pipx", signals: [`${pyproject.from ?? "pyproject.toml"} console script "${pyproject.scripts[0]}"`] };
  const signals: string[] = [];
  if (dirs.includes("docs")) signals.push("docs/ folder");
  if (files.includes("mkdocs.yml")) signals.push("mkdocs.yml");
  const content = files.filter((f) => !IGNORED_FILE.test(f));
  if (content.length > 0 && content.every((f) => /\.(md|markdown)$/i.test(f))) signals.push("only Markdown files");
  return signals.length ? { kind: "guide", signals } : { kind: null, signals: pyproject ? ["pyproject.toml without console scripts"] : [] };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export function packageName(repoName: string): string {
  const s = slug(repoName);
  return s.length >= 3 ? s : `${s || "tool"}-osint`.slice(0, 40);
}

/** Repository descriptions become summaries: 10-140 characters, cut at a word boundary when too long. */
export function summaryFrom(description: string | null): { summary: string | null; cut: boolean } {
  const d = (description ?? "").replace(/\s+/g, " ").trim();
  if (d.length < 10) return { summary: null, cut: false };
  if (d.length <= 140) return { summary: d, cut: false };
  const head = d.slice(0, 139);
  const space = head.lastIndexOf(" ");
  return { summary: `${head.slice(0, space > 80 ? space : 139).replace(/[\s,.;:-]+$/, "")}…`, cut: true };
}

/** The highest vX.Y.Z tag, preferring stable releases. */
export function latestReleaseTag(tags: string[]): string | null {
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  const stable = releases.filter((t) => !t.includes("-"));
  const pool = stable.length ? stable : releases;
  const cmp = (a: string, b: string) => {
    const x = semverParts(a.slice(1)), y = semverParts(b.slice(1));
    return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  };
  return pool.reduce<string | null>((best, t) => (!best || cmp(t, best) > 0 ? t : best), null);
}

export const defaultImage = (provider: Provider, path: string) => `${provider === "github" ? "ghcr.io" : "registry.gitlab.com"}/${path.toLowerCase()}`;

const humanize = (s: string) => {
  const words = s.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The draft manifest for a kind, and the values the author should check because they were guessed. */
export function buildDraft(f: Facts, kind: Kind | null): { manifest: Record<string, unknown>; assumed: string[] } {
  const assumed: string[] = [];
  const m: Record<string, unknown> = { schema: 1 };
  if (kind === "guide") m.kind = "guide";
  const name = packageName(f.repoName);
  if (name !== slug(f.repoName)) assumed.push(`name: "${f.repoName}" is not a valid package name, so it is "${name}"`);
  m.name = name;
  m.namespace = f.namespace;
  m.version = f.latestTag ? f.latestTag.slice(1) : "0.1.0";
  if (!f.latestTag) assumed.push("version: there are no vX.Y.Z tags yet, so it starts at 0.1.0");
  const { summary, cut } = summaryFrom(f.description);
  if (summary) m.summary = summary;
  if (cut) assumed.push("summary: the repository description was longer than 140 characters and was shortened");
  if (f.license) m.license = f.license;
  m.homepage = f.url;
  let categories = categoriesFrom(f.topics);
  if (categories.length === 0) {
    categories = ["utilities"];
    assumed.push('categories: no repository topic matched a registry category, so it is "utilities"');
  }
  m.categories = categories;
  const tags = f.topics
    .map((t) => t.toLowerCase())
    .filter((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t) && t.length <= 32 && !categories.includes(t))
    .slice(0, 10);
  if (tags.length) m.tags = tags;

  if (kind === "guide") {
    m.title = humanize(f.repoName).slice(0, 120);
    m.level = "beginner";
    m.format = "guide";
    m.language = "en";
    assumed.push('title, level ("beginner") and format ("guide") are defaults');
    if (f.docs) m.content = f.docs;
    m.related_tools = [];
    const topics = f.topics.filter((t) => INPUT_TYPES.includes(t) && !PARAMETER_TYPES.has(t));
    if (topics.length) m.topics = topics;
    return { manifest: m, assumed };
  }
  if (!kind) return { manifest: m, assumed };

  if (f.readme) m.readme = f.readme;
  const runtime: Record<string, unknown> = { kind };
  if (kind === "docker") {
    const ref = f.image?.ref ?? defaultImage(f.provider, f.path);
    runtime.image = `${ref}@${f.image?.digest ?? `sha256:${ZERO}`}`;
    runtime.platforms = f.image?.digest ? f.image.platforms : ["linux/amd64", "linux/arm64"];
    if (!f.image?.digest) assumed.push(`runtime.image: no image tagged ${m.version} was found at ${ref}; the digest is a placeholder the release workflow fills in`);
  } else {
    const py = f.pypi ?? { package: name, entrypoint: null, version: null, wheelSha256: null };
    runtime.package = py.package;
    runtime.package_version = py.version ?? m.version;
    runtime.index = "pypi";
    runtime.python = ">=3.10";
    runtime.entrypoint = py.entrypoint ?? name;
    runtime.wheel_sha256 = py.wheelSha256 ?? ZERO;
    if (!py.wheelSha256) assumed.push(`runtime.wheel_sha256: ${py.package} has no wheel on PyPI yet; the hash is a placeholder the release workflow fills in`);
  }
  runtime.output_format = "json";
  runtime.timeout_seconds = 300;
  assumed.push('runtime.output_format: "json"; change it if the tool prints jsonl, csv or text');
  m.runtime = runtime;
  return { manifest: m, assumed };
}

/** Required parts of the manifest the author still has to provide. */
export function missingFields(m: Record<string, any>): string[] {
  const out: string[] = [];
  if (typeof m.summary !== "string" || m.summary.length < 10) out.push("summary");
  if (!m.license) out.push("license");
  if (m.kind === "guide") {
    if (!m.content) out.push("content");
    return out;
  }
  if (!m.runtime) return [...out, "kind"];
  if (!m.readme) out.push("readme");
  if (!Array.isArray(m.inputs) || m.inputs.length === 0) out.push("inputs");
  if (!Array.isArray(m.outputs) || m.outputs.length === 0) out.push("outputs");
  if (!Array.isArray(m.runtime.command) || m.runtime.command.length === 0) out.push("command");
  if (!m.ethics) out.push("ethics");
  return out;
}

/** Optional parts worth filling in: a test input (smoke tests and health checks) and a guide's tools. */
export function suggestedFields(m: Record<string, any>): string[] {
  if (m.kind === "guide") return Array.isArray(m.related_tools) && m.related_tools.length ? [] : ["related_tools"];
  return m.runtime && !m.test ? ["test"] : [];
}

const ORDER = ["schema", "kind", "name", "namespace", "version", "title", "summary", "readme", "license", "homepage", "categories", "tags",
  "level", "format", "language", "content", "related_tools", "topics", "inputs", "outputs", "runtime", "secrets", "network", "ethics", "test", "docs"];

/** Keys in the order `ot init` writes them, so the file in the pull request reads naturally. */
export function ordered(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (m[k] !== undefined) out[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in out)) out[k] = m[k];
  return out;
}

export function manifestYaml(m: Record<string, unknown>): string {
  return `# OTInstaller manifest. Reference: https://otinstaller.com/docs/manifest\n# yaml-language-server: $schema=https://otinstaller.com/schema/v1.json\n` +
    YAML.stringify(ordered(m), { lineWidth: 0 });
}

// ---------- reading repositories ----------

interface Reader {
  dir(path: string): Promise<DirEntry[] | null>;
  file(path: string): Promise<string | null>;
  tags(): Promise<string[]>;
}

/** A repository the user may import, as the host reports it. */
export interface Repo {
  provider: Provider;
  projectId: string;
  path: string;
  url: string;
  defaultBranch: string;
  description: string | null;
  topics: string[];
  license: string | null;
  archived: boolean;
  namespace: { id?: string; name: string; status: string };
  canHoldManifest: boolean;
  installationId: number | null;
  gitlabProject?: gitlab.GitlabProject;
  community: boolean;
  reader: Reader;
}

type Installation = { github_installation_id: number; repo_ids: string; repository_selection: string; namespace_id: string; name: string; status: string };

/** The GitHub App installation that covers a repository, if any. */
export async function installationFor(env: Env, ownerLogin: string, repoId: string): Promise<{ installed: Installation | null; account: Installation | null }> {
  const rows = await env.DB.prepare(
    `SELECT i.github_installation_id, i.repo_ids, i.repository_selection, n.id AS namespace_id, n.name, n.status
     FROM installations i JOIN namespaces n ON n.id = i.namespace_id WHERE lower(i.account_login) = lower(?) AND i.suspended_at IS NULL`,
  ).bind(ownerLogin).all<Installation>();
  const installed = rows.results.find((i) => i.repository_selection === "all" || (JSON.parse(i.repo_ids) as string[]).includes(repoId)) ?? null;
  return { installed, account: installed ?? rows.results[0] ?? null };
}

export const installUrl = (env: Env) => `https://github.com/apps/${env.GITHUB_APP_SLUG ?? "otinstaller"}/installations/new`;

/** The namespace a GitHub account publishes into: the existing one, or the name it would get. */
async function githubNamespaceName(env: Env, owner: { id: number; login: string }) {
  const existing = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE provider = 'github' AND provider_owner_id = ?`)
    .bind(String(owner.id)).first<{ id: string; name: string; status: string }>();
  if (existing) return existing;
  let name = slug(owner.login);
  if (RESERVED_NAMESPACES.has(name) || (await env.DB.prepare(`SELECT 1 FROM namespaces WHERE name = ?`).bind(name).first())) name = `${name.slice(0, 37)}-gh`;
  return { name, status: "pending_review" };
}

async function linkedAccount(env: Env, userId: string, provider: Provider) {
  return env.DB.prepare(`SELECT provider_user_id, login FROM accounts WHERE user_id = ? AND provider = ?`)
    .bind(userId, provider).first<{ provider_user_id: string; login: string }>();
}

/** The community namespace, which must exist before wrappers can be imported. */
async function communityNamespace(env: Env) {
  const ns = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE name = ?`).bind(COMMUNITY_NAMESPACE).first<{ id: string; name: string; status: string }>();
  return ns ?? refuse(409, "community_namespace_missing", `the ${COMMUNITY_NAMESPACE} namespace does not exist yet; install the GitHub App on its organization first`);
}

/** Registry admins and owners of the community namespace may package tools they don't own. */
export async function isCommunityAdmin(env: Env, user: User): Promise<boolean> {
  if (user.is_admin) return true;
  return !!(await env.DB.prepare(
    `SELECT 1 FROM namespace_members m JOIN namespaces n ON n.id = m.namespace_id WHERE n.name = ? AND m.user_id = ? AND m.role = 'owner'`,
  ).bind(COMMUNITY_NAMESPACE, user.id).first());
}

/**
 * Opens a repository for import, checking that the user may import it. A community import reads someone
 * else's repository (the upstream), so it needs no access beyond seeing it, and drafts into the community
 * namespace.
 */
export async function openRepo(env: Env, userId: string, provider: Provider, ref: string, opts: { community?: boolean } = {}): Promise<Repo> {
  const community = !!opts.community;
  if (provider === "github") {
    let token: string;
    try {
      token = await githubUserToken(env, userId);
    } catch {
      return refuse(400, "github_not_linked", "link your GitHub account first", "sign in with GitHub from Settings");
    }
    const r = await github.getRepo(deps.fetch, token, ref);
    if (!r) return refuse(404, "repo_not_found", `${ref} does not exist or you cannot see it`);
    if (r.private) return refuse(400, "repo_not_public", "only public repositories can publish to the registry");
    if (!community && !r.permissions?.admin) {
      return refuse(403, "not_admin", `you need admin access to ${r.full_name} to import it`, `${COMMUNITY_NAMESPACE} admins can package it as a community wrapper instead`);
    }
    const { installed, account } = await installationFor(env, r.owner.login, String(r.id));
    const namespace = community
      ? await communityNamespace(env)
      : account ? { id: account.namespace_id, name: account.name, status: account.status } : await githubNamespaceName(env, r.owner);
    const acct = await linkedAccount(env, userId, "github");
    const owns = community
      ? false
      : r.owner.type === "User"
        ? String(r.owner.id) === acct?.provider_user_id
        : (await github.orgRole(deps.fetch, token, r.owner.login)) === "admin";
    // Reads go through the App when it is installed (higher rate limits), otherwise as the user.
    let readToken: Promise<string> | null = null;
    const tok = () =>
      (readToken ??= installed
        ? github.installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), installed.github_installation_id)
        : Promise.resolve(token));
    return {
      provider, projectId: String(r.id), path: r.full_name, url: r.html_url, defaultBranch: r.default_branch, description: r.description,
      topics: r.topics ?? [], license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null, archived: r.archived,
      namespace, canHoldManifest: owns, installationId: installed?.github_installation_id ?? null, community,
      reader: {
        dir: async (p) => github.listDir(deps.fetch, await tok(), r.full_name, p, r.default_branch),
        file: async (p) => github.fileAt(deps.fetch, await tok(), r.full_name, p, r.default_branch),
        tags: async () => github.listTags(deps.fetch, await tok(), r.full_name),
      },
    };
  }
  let token: string;
  try {
    token = await gitlabToken(env, userId);
  } catch {
    return refuse(400, "gitlab_not_linked", "link your GitLab account first", "sign in with GitLab from Settings");
  }
  const p = await gitlab.getProject(deps.fetch, token, ref, true);
  if (!p) return refuse(404, "project_not_found", `${ref} does not exist or you cannot see it`);
  if (p.visibility !== "public") return refuse(400, "project_not_public", "only public projects can publish to the registry");
  if (!community && gitlab.accessLevel(p) < gitlab.MAINTAINER) {
    return refuse(403, "not_maintainer", `you need Maintainer access or above to import ${p.path_with_namespace}`, `${COMMUNITY_NAMESPACE} admins can package it as a community wrapper instead`);
  }
  const acct = await linkedAccount(env, userId, "gitlab");
  const owns = !community && (p.namespace.kind === "user"
    ? p.namespace.path.toLowerCase() === acct?.login.toLowerCase()
    : gitlab.accessLevel(p) >= gitlab.OWNER);
  const branch = p.default_branch ?? "main";
  const id = String(p.id);
  return {
    provider, projectId: id, path: p.path_with_namespace, url: p.web_url, defaultBranch: branch, description: p.description ?? null,
    topics: p.topics ?? p.tag_list ?? [], license: gitlabLicense(p.license?.key), archived: p.archived,
    namespace: community ? await communityNamespace(env) : await gitlabNamespaceName(env, p.namespace), canHoldManifest: owns, installationId: null,
    gitlabProject: p, community,
    reader: {
      dir: (d) => gitlab.listTree(deps.fetch, token, id, d, branch),
      file: (f) => gitlab.rawFile(deps.fetch, token, id, f, branch),
      tags: () => gitlab.listTags(deps.fetch, token, id),
    },
  };
}

/** Reads the repository and records what it contains. */
export async function detect(env: Env, repo: Repo): Promise<{ facts: Facts; draft: Record<string, unknown>; assumed: string[]; warnings: string[] }> {
  const published = await sourceByProject(env, repo.provider, repo.projectId);
  if (published?.tool_id) {
    const t = await env.DB.prepare(`SELECT n.name AS ns, t.name FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE t.id = ?`).bind(published.tool_id).first<{ ns: string; name: string }>();
    refuse(409, "already_published", `${repo.path} is already published${t ? ` as ${t.ns}/${t.name}` : ""}`);
  }
  const r = repo.reader;
  const root = (await r.dir("")) ?? [];
  const has = (name: string) => root.some((e) => e.type === "file" && e.name === name);
  const readme = root.find((e) => e.type === "file" && /^readme(\.(md|markdown|rst|txt))?$/i.test(e.name))?.name ?? null;
  let license = repo.license;
  if (!license) {
    const file = root.find((e) => e.type === "file" && /^(license|licence|copying)(\.(md|txt))?$/i.test(e.name));
    if (file) license = licenseFromText((await r.file(file.name)) ?? "");
  }
  if (repo.community) {
    // Wrappers only where the license allows it, and only when upstream doesn't publish the tool itself.
    if (!isRedistributable(license)) {
      refuse(400, "license_not_redistributable", `${repo.path} has ${license ? `the license ${license}, which` : "no license that"} the registry accepts for community wrappers`,
        "ask the maintainer to publish it themselves");
    }
    if (has(MANIFEST_FILE)) refuse(409, "upstream_has_manifest", `${repo.path} already has ${MANIFEST_FILE}; its maintainer can publish it, so it needs no wrapper`);
  }
  // Console scripts from pyproject.toml, or from setup.cfg for setuptools projects that declare them there.
  const toml = has("pyproject.toml") ? pyprojectInfo((await r.file("pyproject.toml")) ?? "") : null;
  const cfg = !toml?.scripts.length && has("setup.cfg") ? setupCfgInfo((await r.file("setup.cfg")) ?? "") : null;
  const py = cfg?.scripts.length ? { name: toml?.name ?? cfg.name, scripts: cfg.scripts, from: "setup.cfg" } : toml;
  const existingText = has(MANIFEST_FILE) ? await r.file(MANIFEST_FILE) : null;
  const latestTag = latestReleaseTag(await r.tags());
  const version = latestTag?.slice(1);
  const warnings: string[] = [];
  if (repo.archived) warnings.push("the repository is archived; packages from archived repositories are marked deprecated");
  if (repo.community) {
    warnings.push(`community wrapper of ${repo.url}: finish with a wrapper repository in ${COMMUNITY_NAMESPACE}; the package is labelled Community-packaged and links back here`);
  } else if (repo.provider === "github" && !repo.installationId) {
    warnings.push(`the OTInstaller GitHub App is not installed on ${repo.path}; install it before finishing: ${installUrl(env)}`);
  }

  const base = {
    provider: repo.provider, path: repo.path, url: repo.url, defaultBranch: repo.defaultBranch, namespace: repo.namespace.name,
    repoName: repo.path.split("/").pop()!, description: repo.description, topics: repo.topics, license, readme,
    latestTag, hasGitlabCi: has(".gitlab-ci.yml"), canHoldManifest: repo.canHoldManifest, appInstalled: repo.provider === "gitlab" || !!repo.installationId,
    ...(repo.community ? { community: true } : {}),
  };

  if (existingText !== null) {
    // The repository already has a manifest: use it as it is.
    const doc = (() => {
      try {
        const d = YAML.parse(existingText);
        return d && typeof d === "object" && !Array.isArray(d) ? (JSON.parse(JSON.stringify(d)) as Record<string, any>) : {};
      } catch {
        return {};
      }
    })();
    const kind: Kind | null = doc.kind === "guide" ? "guide" : doc.runtime?.kind === "docker" || doc.runtime?.kind === "pipx" ? doc.runtime.kind : null;
    const facts: Facts = { ...base, signals: [MANIFEST_FILE], kind, existingManifest: true, image: null, pypi: null, docs: null };
    return { facts, draft: doc, assumed: [`${MANIFEST_FILE} already exists in the repository; finishing connects the repository without changing it`], warnings };
  }

  const { kind, signals } = detectKind(root, py);
  let image: Facts["image"] = null;
  if (kind === "docker") {
    const ref = defaultImage(repo.provider, repo.path);
    const found = version ? (await imageDigest(deps.fetch, ref, version)) ?? (await imageDigest(deps.fetch, ref, `v${version}`)) : null;
    image = { ref, digest: found?.digest ?? null, platforms: found?.platforms ?? [] };
  }
  let pypi: Facts["pypi"] = null;
  if (kind === "pipx") {
    const pkg = py?.name ?? packageName(base.repoName);
    const rel = (version ? await pypiRelease(deps.fetch, pkg, version) : null) ?? (await pypiRelease(deps.fetch, pkg));
    pypi = { package: pkg, entrypoint: py?.scripts[0] ?? null, version: rel?.version ?? null, wheelSha256: rel?.wheelSha256 ?? null };
  }
  let docs: Facts["docs"] = null;
  if (kind === "guide") {
    const pages = ((await r.dir("docs")) ?? []).filter((e) => e.type === "file" && /\.md$/i.test(e.name)).map((e) => e.name);
    const first = (p: string) => (/^(index|readme)\.md$/i.test(p) ? 0 : 1);
    pages.sort((a, b) => first(a) - first(b) || a.localeCompare(b));
    if (pages.length) docs = { root: "docs/", nav: pages.slice(0, 100) };
    else warnings.push("no Markdown pages were found in docs/; add the guide's pages to content.nav");
  }
  const facts: Facts = { ...base, signals, kind, existingManifest: false, image, pypi, docs };
  const { manifest, assumed } = buildDraft(facts, kind);
  if (!kind) warnings.push("could not tell what this repository is (no Dockerfile, console script in pyproject.toml or setup.cfg, docs/ or Markdown-only content); choose a kind to continue");
  return { facts, draft: manifest, assumed, warnings };
}

// ---------- import rows ----------

export type ImportRow = {
  id: string;
  user_id: string;
  batch_id: string | null;
  community: number;
  wrapper_path: string | null;
  provider: Provider;
  project_id: string | null;
  path: string;
  url: string | null;
  namespace: string | null;
  detected_kind: Kind | null;
  detection_json: string | null;
  draft_manifest_json: string | null;
  finish_mode: FinishMode | null;
  pr_url: string | null;
  source_id: string | null;
  status: "detecting" | "draft" | "ready" | "finished" | "failed";
  error_code: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type Detection = { facts: Facts; assumed: string[]; warnings: string[] };

export async function importById(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM imports WHERE id = ?`).bind(id).first<ImportRow>();
}

/** Schema problems, plus the namespace and name rules publishing will apply. */
export async function draftProblems(env: Env, row: ImportRow, draft: Record<string, unknown>): Promise<Problem[]> {
  const { manifest, problems } = parseManifest(JSON.stringify(draft));
  if (!manifest) return problems;
  if (row.namespace && manifest.namespace !== row.namespace) {
    problems.push({ code: "manifest_namespace_mismatch", path: "/namespace", message: `this repository publishes to "${row.namespace}", not "${manifest.namespace}"` });
  }
  const owner = await env.DB.prepare(
    `SELECT t.repo_url FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE n.name = ? AND t.name = ?`,
  ).bind(manifest.namespace, manifest.name).first<{ repo_url: string | null }>();
  if (owner?.repo_url && owner.repo_url.toLowerCase() !== (row.url ?? "").toLowerCase()) {
    problems.push({ code: "manifest_name_taken", path: "/name", message: `${manifest.namespace}/${manifest.name} is published from ${owner.repo_url}` });
  }
  return problems;
}

async function saveDetection(env: Env, row: ImportRow, repo: Repo, d: Awaited<ReturnType<typeof detect>>) {
  const next = { ...row, project_id: repo.projectId, path: repo.path, url: repo.url, namespace: repo.namespace.name };
  const problems = await draftProblems(env, next, d.draft);
  const detection: Detection = { facts: d.facts, assumed: d.assumed, warnings: d.warnings };
  await env.DB.prepare(
    `UPDATE imports SET project_id = ?, path = ?, url = ?, namespace = ?, detected_kind = ?, detection_json = ?, draft_manifest_json = ?,
       status = ?, error_code = NULL, error = NULL, updated_at = ? WHERE id = ?`,
  ).bind(repo.projectId, repo.path, repo.url, repo.namespace.name, d.facts.kind, JSON.stringify(detection), JSON.stringify(d.draft),
    problems.length ? "draft" : "ready", Date.now(), row.id).run();
}

/** Detects one queued import (bulk imports). Refusals are recorded on the import; host outages retry. */
export async function detectQueued(env: Env, id: string) {
  const row = await importById(env, id);
  if (!row || row.status !== "detecting") return;
  try {
    const repo = await openRepo(env, row.user_id, row.provider, row.path, { community: row.community === 1 });
    await saveDetection(env, row, repo, await detect(env, repo));
  } catch (e) {
    if (e instanceof ImportProblem) return failImport(env, id, e.code, e.message);
    if (e instanceof HostError && !e.transient) return failImport(env, id, "host_error", e.message);
    throw e;
  }
}

export async function failImport(env: Env, id: string, code: string, message: string) {
  await env.DB.prepare(`UPDATE imports SET status = 'failed', error_code = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'detecting'`)
    .bind(code, message.slice(0, 500), Date.now(), id).run();
}

/** Parses "https://github.com/owner/repo", "gitlab.com/group/sub/project" or "owner/repo" (with a default provider). */
export function parseRepoRef(input: string, fallback?: Provider): { provider: Provider; path: string } | null {
  let s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let provider = fallback;
  const m = /^(?:https?:\/\/)?(?:www\.)?(github|gitlab)\.com[/:](.+)$/i.exec(s) ?? /^git@(github|gitlab)\.com:(.+)$/i.exec(s);
  if (m) {
    provider = m[1]!.toLowerCase() as Provider;
    s = m[2]!;
  }
  if (!provider) return null;
  s = s.replace(/\/-\/.*$/, "").replace(/\/(tree|blob)\/.*$/, "");
  const parts = s.split("/").filter(Boolean);
  if (provider === "github" ? parts.length !== 2 : parts.length < 2) return null;
  if (!parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p))) return null;
  return { provider, path: parts.join("/") };
}

/** Starts imports: one repository is detected right away, several are detected in the queue. */
export async function startImports(env: Env, user: User, refs: { provider: Provider; path: string }[], opts: { community?: boolean } = {}): Promise<ImportRow[]> {
  const community = !!opts.community;
  // Anyone signed in may package someone else's tool (it finishes as a reviewed submission); bulk stays with admins.
  if (community && !(await isCommunityAdmin(env, user))) {
    if (refs.length > 1) refuse(403, "not_community_admin", `only ${COMMUNITY_NAMESPACE} admins can package several tools at once`);
    await dailyLimit(env, "community-import", user.id, 10);
  }
  const now = Date.now();
  const batch = refs.length > 1 ? ulid(now) : null;
  const rows: ImportRow[] = refs.map((r) => ({
    id: ulid(now), user_id: user.id, batch_id: batch, community: community ? 1 : 0, wrapper_path: null, provider: r.provider, project_id: null, path: r.path, url: null, namespace: null,
    detected_kind: null, detection_json: null, draft_manifest_json: null, finish_mode: null, pr_url: null, source_id: null,
    status: "detecting", error_code: null, error: null, created_at: now, updated_at: now,
  }));
  if (rows.length === 1) {
    // Detect before writing anything, so a refusal leaves no row behind.
    const repo = await openRepo(env, user.id, rows[0]!.provider, rows[0]!.path, { community });
    const d = await detect(env, repo);
    await env.DB.prepare(`INSERT INTO imports (id, user_id, community, provider, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'detecting', ?, ?)`)
      .bind(rows[0]!.id, user.id, community ? 1 : 0, repo.provider, repo.path, now, now).run();
    await saveDetection(env, rows[0]!, repo, d);
  } else {
    await env.DB.batch(rows.map((r) =>
      env.DB.prepare(`INSERT INTO imports (id, user_id, batch_id, community, provider, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'detecting', ?, ?)`)
        .bind(r.id, user.id, batch, community ? 1 : 0, r.provider, r.path, now, now),
    ));
    for (const r of rows) await env.PUBLISH_QUEUE.send({ importId: r.id });
  }
  await audit(env.DB, user.id, "user", "import.start", "import", batch ?? rows[0]!.id, { repos: refs.map((r) => `${r.provider}:${r.path}`) }).run();
  return (await Promise.all(rows.map((r) => importById(env, r.id)))).filter((r): r is ImportRow => !!r);
}

/** Applies an edit: a partial manifest (null removes a key), a whole YAML document, or another kind. */
export async function editImport(env: Env, row: ImportRow, body: { manifest?: Record<string, unknown>; yaml?: string; kind?: string }) {
  if (row.status === "finished") refuse(409, "import_finished", "this import is finished; edit the package instead");
  if (row.status === "detecting" || row.status === "failed" || !row.detection_json) refuse(409, "import_not_detected", "detection has not finished for this import");
  const detection = JSON.parse(row.detection_json!) as Detection;
  let draft = JSON.parse(row.draft_manifest_json ?? "{}") as Record<string, unknown>;
  if (body.kind !== undefined) {
    if (!["docker", "pipx", "guide"].includes(body.kind)) refuse(400, "invalid_kind", "kind must be docker, pipx or guide");
    if (detection.facts.existingManifest) refuse(409, "manifest_in_repo", `the repository already has ${MANIFEST_FILE}; change it there`);
    const facts = { ...detection.facts, kind: body.kind as Kind };
    if (facts.kind === "pipx" && !facts.pypi) facts.pypi = { package: packageName(facts.repoName), entrypoint: null, version: null, wheelSha256: null };
    if (facts.kind === "docker" && !facts.image) facts.image = { ref: defaultImage(facts.provider, facts.path), digest: null, platforms: [] };
    const rebuilt = buildDraft(facts, facts.kind);
    // Keep what the author already wrote that still applies to the new kind.
    const keep = facts.kind === "guide" ? ["summary", "license", "categories", "tags"] : ["summary", "license", "categories", "tags", "readme", "inputs", "outputs", "ethics", "test", "secrets"];
    for (const k of keep) if (draft[k] !== undefined) rebuilt.manifest[k] = draft[k];
    if (facts.kind !== "guide" && (draft.runtime as any)?.command) (rebuilt.manifest.runtime as any).command = (draft.runtime as any).command;
    draft = rebuilt.manifest;
    detection.facts = facts;
    detection.assumed = rebuilt.assumed;
  }
  if (body.yaml !== undefined) {
    try {
      const doc = YAML.parse(body.yaml);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("manifest must be a YAML mapping");
      draft = JSON.parse(JSON.stringify(doc));
    } catch (e) {
      refuse(400, "manifest_yaml_invalid", (e as Error).message);
    }
  }
  if (body.manifest) {
    for (const [k, v] of Object.entries(body.manifest)) {
      if (v === null) delete draft[k];
      else draft[k] = v;
    }
  }
  if (row.namespace && draft.namespace !== undefined && draft.namespace !== row.namespace) {
    refuse(400, "manifest_namespace_mismatch", `this repository publishes to "${row.namespace}"`);
  }
  const problems = await draftProblems(env, row, draft);
  const kind = draft.kind === "guide" ? "guide" : ((draft.runtime as any)?.kind ?? null);
  await env.DB.prepare(`UPDATE imports SET draft_manifest_json = ?, detection_json = ?, detected_kind = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(draft), JSON.stringify(detection), ["docker", "pipx", "guide"].includes(kind) ? kind : null, problems.length ? "draft" : "ready", Date.now(), row.id).run();
}

// ---------- finishing ----------

/** The files a pull or merge request adds: the manifest and the release workflow. */
export function changeFiles(provider: Provider, draft: Record<string, unknown>, hasGitlabCi: boolean, workflowExists = false): { files: (FileChange & { exists?: boolean })[]; notes: string[] } {
  const files: (FileChange & { exists?: boolean })[] = [{ path: MANIFEST_FILE, content: manifestYaml(draft) }];
  const notes: string[] = [];
  const kind = draft.kind === "guide" ? "guide" : (draft.runtime as { kind?: string } | undefined)?.kind;
  if (kind === "docker" || kind === "pipx" || kind === "guide") {
    const template = RELEASE_TEMPLATES[`${provider}-${kind}`]!;
    if (provider === "github") {
      if (!workflowExists) files.push({ path: ".github/workflows/otinstaller-release.yml", content: template });
    } else if (hasGitlabCi) {
      // An existing pipeline is never rewritten; the release job goes in its own file to include.
      files.push({ path: ".gitlab/otinstaller-release.yml", content: template });
      notes.push("This project already has a `.gitlab-ci.yml`, so the release job is in `.gitlab/otinstaller-release.yml`. " +
        "Add it to your pipeline before merging:\n\n```yaml\ninclude:\n  - local: .gitlab/otinstaller-release.yml\n```");
    } else {
      files.push({ path: ".gitlab-ci.yml", content: template });
    }
  }
  return { files, notes };
}

function changeBody(env: Env, provider: Provider, draft: Record<string, unknown>, login: string, notes: string[]): string {
  const ref = `${draft.namespace}/${draft.name}`;
  const guide = draft.kind === "guide";
  // A guide's workflow only sets the version and tags; a tool's also builds and signs or pins the release.
  const does = guide ? "It updates `version:` in `otinstaller.yaml` and pushes the tag." : "It builds the release, signs or pins it, updates `otinstaller.yaml` and pushes the tag.";
  const steps = provider === "github"
    ? ["Merge this pull request.", `Run the **otinstaller release** workflow from the Actions tab with the version to release. ${does}`]
    : ["In Settings > CI/CD > Job token permissions, turn on **Allow Git push requests to the repository**, so the pipeline can push the release commit and tag. (Or set the CI/CD variable `RELEASE_TOKEN` to a token with `write_repository`.)", "Merge this merge request.",
      `To release, set \`version:\` in \`otinstaller.yaml\` and commit, then run a pipeline from **Build > Pipelines > Run pipeline**. ${does}`];
  if (guide) steps.push(`Or push a tag such as \`v${draft.version}\` yourself, matching \`version:\` in otinstaller.yaml.`);
  steps.push("The tag publishes that version to the registry. A new publisher's first release is checked by a reviewer before it goes public.");
  return [
    `This adds \`otinstaller.yaml\` and a release workflow so **${ref}** can be published on the [OTInstaller Registry](${env.SITE_URL}).`,
    "",
    "**To publish**",
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    ...(notes.length ? ["", ...notes] : []),
    "",
    `Review the manifest before merging, especially \`inputs\`, \`runtime.command\` and \`ethics\`. Reference: https://otinstaller.com/docs/manifest`,
    "",
    `Opened from the import wizard by @${login}.`,
  ].join("\n");
}

const CHANGE_TITLE = "Publish on the OTInstaller Registry";

/**
 * Opens the pull or merge request with the manifest (or the given files). GitHub goes through the App;
 * GitLab through the user.
 */
export async function openChange(
  env: Env, user: User, target: { provider: Provider; projectId: string; path: string; defaultBranch: string; installationId: number | null; hasGitlabCi: boolean },
  draft: Record<string, unknown>, custom?: { files: (FileChange & { exists?: boolean })[]; notes: string[] },
) {
  if (target.provider === "github") {
    if (!target.installationId) refuse(409, "app_not_installed", `install the OTInstaller GitHub App on ${target.path} first`, installUrl(env));
    const token = await github.installationToken(deps.fetch, requireSecret(env, "GITHUB_APP_ID"), requireSecret(env, "GITHUB_APP_PRIVATE_KEY"), target.installationId!);
    const { files, notes } = custom ?? changeFiles("github", draft, false,
      (await github.fileAt(deps.fetch, token, target.path, ".github/workflows/otinstaller-release.yml", target.defaultBranch)) !== null);
    try {
      return await github.openPullRequest(deps.fetch, token, target.path, target.defaultBranch, IMPORT_BRANCH, files, CHANGE_TITLE, changeBody(env, "github", draft, user.login, notes));
    } catch (e) {
      if (e instanceof HostError && (e.status === 403 || e.status === 404)) {
        refuse(403, "github_permission_required", "the OTInstaller GitHub App needs write access to contents, workflows and pull requests to open a pull request",
          "accept the App's updated permissions under your GitHub settings → Applications, or finish with a registry-held manifest");
      }
      throw e;
    }
  }
  const token = await gitlabToken(env, user.id);
  const { files, notes } = custom ?? changeFiles("gitlab", draft, target.hasGitlabCi);
  try {
    return await gitlab.openMergeRequest(deps.fetch, token, target.projectId, target.defaultBranch, IMPORT_BRANCH, files, CHANGE_TITLE, changeBody(env, "gitlab", draft, user.login, notes));
  } catch (e) {
    if (e instanceof HostError && e.status === 403) {
      refuse(403, "gitlab_scope_required", "opening a merge request needs permission to write to the project", `sign in again at ${env.API_URL}/v1/auth/gitlab/login?scope=api`);
    }
    throw e;
  }
}

/** A registry-held manifest has to point at a real, published artifact. */
export function heldManifestProblems(m: Record<string, any>): Problem[] {
  const rt = m.runtime ?? {};
  if (rt.kind === "docker" && String(rt.image ?? "").endsWith(ZERO)) {
    return [{ code: "artifact_image_not_found", path: "/runtime/image", message: "a registry-held manifest needs the digest of a published image", hint: "push the image, then set runtime.image to image@sha256:..." }];
  }
  if (rt.kind === "pipx" && rt.wheel_sha256 === ZERO) {
    return [{ code: "artifact_package_not_found", path: "/runtime/wheel_sha256", message: "a registry-held manifest needs the SHA-256 of a wheel published on PyPI" }];
  }
  return [];
}

/** Each package has one source: the same project on the other host can't become a second package. */
async function mirrorOf(env: Env, row: ImportRow, name: string): Promise<string | null> {
  const other = row.provider === "github" ? "gitlab" : "github";
  const repoName = row.path.split("/").pop()!.toLowerCase();
  const hit = await env.DB.prepare(
    `SELECT n.name AS ns, t.name, s.url FROM sources s JOIN tools t ON t.id = s.tool_id JOIN namespaces n ON n.id = t.namespace_id
     JOIN namespace_members m ON m.namespace_id = n.id
     WHERE s.provider = ? AND t.name = ? AND m.user_id = ? AND lower(s.path) LIKE ?`,
  ).bind(other, name, row.user_id, `%/${repoName}`).first<{ ns: string; name: string; url: string }>();
  return hit ? `${hit.ns}/${hit.name} is already published from ${hit.url}; switch its source from the dashboard instead of importing a mirror` : null;
}

export async function finishImport(env: Env, user: User, row: ImportRow, mode: FinishMode, opts: { wrapper?: string } = {}) {
  if (row.status === "finished") refuse(409, "import_finished", "this import is already finished");
  if (!row.detection_json || row.status === "detecting" || row.status === "failed") refuse(409, "import_not_detected", "detection has not finished for this import");
  const detection = JSON.parse(row.detection_json!) as Detection;
  const facts = detection.facts;
  if (row.community === 1 || mode === "wrapper") {
    if (row.community !== 1 || mode !== "wrapper") refuse(400, "invalid_mode", `community imports finish with mode "wrapper" (and only they do)`);
    return finishWrapper(env, user, row, facts, opts.wrapper);
  }
  if (facts.existingManifest && mode !== "connect") refuse(409, "manifest_in_repo", `the repository already has ${MANIFEST_FILE}; finish with mode "connect"`);
  if (!facts.existingManifest && mode === "connect") refuse(400, "invalid_mode", `"connect" is for repositories that already have ${MANIFEST_FILE}; use "pr" or "registry"`);
  const draft = JSON.parse(row.draft_manifest_json ?? "{}") as Record<string, any>;
  const problems = await draftProblems(env, row, draft);
  if (mode === "registry") problems.push(...heldManifestProblems(draft));
  if (problems.length) {
    throw Object.assign(new ImportProblem(409, "import_not_ready", `the draft manifest has ${problems.length} problem(s); fix them first`), { problems });
  }
  const mirror = await mirrorOf(env, row, draft.name);
  if (mirror) refuse(409, "mirror_already_imported", mirror);

  // Access is checked again: it may have changed since detection.
  const repo = await openRepo(env, user.id, row.provider, row.project_id ?? row.path);
  if (repo.provider === "github" && !repo.installationId) refuse(409, "app_not_installed", `install the OTInstaller GitHub App on ${repo.path} first`, installUrl(env));
  if (mode === "registry" && !repo.canHoldManifest) {
    refuse(403, "not_repo_owner", "only the repository's owner (or an org/group owner) can keep its manifest on the registry", "open a pull or merge request instead");
  }

  let prUrl: string | null = null;
  let sourceId: string | null = null;
  let queued: string | null = null;
  const manifestJson = mode === "registry" ? JSON.stringify(draft) : undefined;
  if (repo.provider === "gitlab") {
    // GitLab needs the project webhook for the first tag after the merge (or the first registry-held release).
    sourceId = (await connectGitlabProject(env, user.id, await gitlabToken(env, user.id), repo.gitlabProject!, manifestJson)).sourceId;
  } else if (mode === "registry") {
    const ns = await env.DB.prepare(`SELECT namespace_id FROM installations WHERE github_installation_id = ?`).bind(repo.installationId).first<{ namespace_id: string }>();
    sourceId = ulid();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, namespace_id, provider, project_id, path, url, default_branch, installation_id, connected_by, manifest_mode, registry_manifest_json, visibility, created_at)
         VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, 'registry', ?, 'public', ?)
         ON CONFLICT (provider, project_id) DO UPDATE SET manifest_mode = 'registry', registry_manifest_json = excluded.registry_manifest_json,
           installation_id = excluded.installation_id, connected_by = excluded.connected_by, default_branch = excluded.default_branch`,
      ).bind(sourceId, ns!.namespace_id, repo.projectId, repo.path, repoUrl("github", repo.path), repo.defaultBranch, repo.installationId, user.id, manifestJson, Date.now()),
      env.DB.prepare(`INSERT OR IGNORE INTO namespace_members (namespace_id, user_id, role) VALUES (?, ?, 'owner')`).bind(ns!.namespace_id, user.id),
    ]);
    sourceId = (await sourceByProject(env, "github", repo.projectId))!.id;
  }
  if (mode === "pr") {
    prUrl = (await openChange(env, user, { ...repo, hasGitlabCi: facts.hasGitlabCi }, draft)).url;
  }
  if (mode === "registry" && facts.latestTag && sourceId) {
    // The newest existing tag can be published right away from the registry-held manifest.
    const s = await sourceById(env, sourceId);
    if (s && (await queueTag(env, s, facts.latestTag, `import:${row.id}:${facts.latestTag}`, repo.path))) queued = facts.latestTag;
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE imports SET status = 'finished', finish_mode = ?, pr_url = ?, source_id = ?, updated_at = ? WHERE id = ?`)
      .bind(mode, prUrl, sourceId, Date.now(), row.id),
    audit(env.DB, user.id, "user", `import.finish.${mode}`, "import", row.id, { repo: repo.path, pr: prUrl, queued }),
  ]);
  return { prUrl, sourceId, queued };
}

/** The README a wrapper repository starts with: what it packages, and credit to the upstream project. */
export function wrapperReadme(draft: Record<string, unknown>, upstream: string): string {
  return `# ${draft.name} (community package)\n\n` +
    `This repository packages [${upstream.replace(/^https:\/\//, "")}](${upstream}) for the OTInstaller Registry as ` +
    `\`${COMMUNITY_NAMESPACE}/${draft.name}\`. The tool is the work of its authors, under the ${draft.license} license; ` +
    `this repository only holds the manifest and release workflow.\n\n` +
    `Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project ` +
    `and want to publish it yourself, open an issue: the package is transferred to you.\n`;
}

/**
 * Finishes a community import: opens a pull/merge request in a wrapper repository owned by the community
 * namespace. The manifest lives in that repository, so wrappers are never registry-held.
 */
async function finishWrapper(env: Env, user: User, row: ImportRow, facts: Facts, wrapperInput: string | undefined) {
  if (!(await isCommunityAdmin(env, user))) refuse(403, "not_community_admin", `only ${COMMUNITY_NAMESPACE} admins can open a wrapper pull request`, `finish with {"mode": "submit"} instead`);
  const ref = wrapperInput ? parseRepoRef(wrapperInput, row.provider) : null;
  if (!ref) return refuse(400, "wrapper_required", `send the wrapper repository, e.g. {"mode": "wrapper", "wrapper_repo": "https://github.com/${COMMUNITY_NAMESPACE}/${facts.repoName}"}`);
  const wrapper = await openRepo(env, user.id, ref.provider, ref.path);
  if (wrapper.namespace.name !== COMMUNITY_NAMESPACE) {
    refuse(409, "wrapper_not_community", `${wrapper.path} publishes to "${wrapper.namespace.name}"; the wrapper repository must belong to ${COMMUNITY_NAMESPACE}`);
  }
  if (wrapper.provider === "github" && !wrapper.installationId) refuse(409, "app_not_installed", `install the OTInstaller GitHub App on ${wrapper.path} first`, installUrl(env));
  const published = await sourceByProject(env, wrapper.provider, wrapper.projectId);
  if (published?.tool_id) refuse(409, "already_published", `${wrapper.path} already publishes a package`);

  const draft = JSON.parse(row.draft_manifest_json ?? "{}") as Record<string, any>;
  draft.homepage = facts.url;
  draft.readme = "README.md";
  // Without a published upstream image, the wrapper builds one from its own Dockerfile.
  const rt = draft.runtime as Record<string, any> | undefined;
  const builds = rt?.kind === "docker" && String(rt.image ?? "").endsWith(ZERO);
  if (builds) rt!.image = `${defaultImage(wrapper.provider, wrapper.path)}@sha256:${ZERO}`;
  const problems = await draftProblems(env, { ...row, url: wrapper.url }, draft);
  if (rt?.kind === "pipx") problems.push(...heldManifestProblems(draft));
  if (problems.length) {
    throw Object.assign(new ImportProblem(409, "import_not_ready", `the draft manifest has ${problems.length} problem(s); fix them first`), { problems });
  }

  const files: (FileChange & { exists?: boolean })[] = [{ path: MANIFEST_FILE, content: manifestYaml(draft) }];
  const notes = [`This is a community package of ${facts.url} (${draft.license}), labelled Community-packaged on the registry with a link back to it.`];
  const readme = await wrapper.reader.file("README.md");
  if (readme === null) files.push({ path: "README.md", content: wrapperReadme(draft, facts.url) });
  if (builds) {
    const hasCi = wrapper.provider === "gitlab" && (await wrapper.reader.file(".gitlab-ci.yml")) !== null;
    files.push(...changeFiles(wrapper.provider, draft, hasCi).files.filter((f) => f.path !== MANIFEST_FILE));
    notes.push(`No published image of the upstream project was found, so the release workflow builds one: add a \`Dockerfile\` that builds ${facts.url} at the version being released.`);
  } else {
    notes.push("The manifest points at the upstream project's own published release, so no build is needed: bump `version` and the pinned artifact, then push a tag.");
  }

  let sourceId: string | null = null;
  if (wrapper.provider === "gitlab") sourceId = (await connectGitlabProject(env, user.id, await gitlabToken(env, user.id), wrapper.gitlabProject!)).sourceId;
  const pr = await openChange(env, user, { ...wrapper, hasGitlabCi: false }, draft, { files, notes });
  await env.DB.batch([
    env.DB.prepare(`UPDATE imports SET status = 'finished', finish_mode = 'wrapper', wrapper_path = ?, pr_url = ?, source_id = ?, updated_at = ? WHERE id = ?`)
      .bind(`${wrapper.provider}:${wrapper.path}`, pr.url, sourceId, Date.now(), row.id),
    audit(env.DB, user.id, "user", "import.finish.wrapper", "import", row.id, { upstream: facts.url, wrapper: wrapper.path, pr: pr.url }),
  ]);
  return { prUrl: pr.url as string | null, sourceId, queued: null as string | null };
}

// ---------- registry-held manifests at publish time ----------

/**
 * The manifest for a tag of a package whose manifest the registry holds. The version comes from the tag,
 * and the artifact is looked up for that version (an image tagged with it, or its PyPI wheel); the stored
 * artifact is used only when the stored manifest was written for this very version.
 */
export async function heldManifestFor(json: string, tag: string): Promise<{ manifest?: Manifest; problems: Problem[] }> {
  const m = JSON.parse(json) as Record<string, any>;
  const version = tag.replace(/^v/, "");
  const sameVersion = m.version === version;
  m.version = version;
  const rt = m.runtime;
  if (rt?.kind === "docker" && typeof rt.image === "string") {
    const ref = rt.image.split("@")[0];
    const found = (await imageDigest(deps.fetch, ref, version)) ?? (await imageDigest(deps.fetch, ref, `v${version}`));
    if (found) {
      rt.image = `${ref}@${found.digest}`;
      rt.platforms = found.platforms;
    } else if (!sameVersion) {
      return { problems: [{ code: "artifact_image_not_found", path: "/runtime/image", message: `no image tagged ${version} was found at ${ref}`, hint: "push the image with the version as its tag, or update the registry-held manifest" }] };
    }
  } else if (rt?.kind === "pipx" && typeof rt.package === "string") {
    const rel = await pypiRelease(deps.fetch, rt.package, version);
    if (rel?.wheelSha256) {
      rt.package_version = version;
      rt.wheel_sha256 = rel.wheelSha256;
    } else if (!sameVersion) {
      return { problems: [{ code: "artifact_package_not_found", path: "/runtime/package_version", message: `${rt.package} ${version} has no wheel on PyPI`, hint: "publish the wheel, or update the registry-held manifest" }] };
    }
  }
  return parseManifest(JSON.stringify(m));
}

/** Ensures an import route's caller owns the import. */
export function requireOwnImport(user: User, row: ImportRow | null): ImportRow {
  if (!row || (row.user_id !== user.id && !user.is_admin)) apiError(404, "import_not_found", "no such import");
  return row;
}
