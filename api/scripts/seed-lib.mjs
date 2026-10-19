// Builds demo registry data from the spec fixtures plus a few extra packages, validating every
// manifest against the schema first. Used by `npm run db:seed` and by the tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(readFileSync(path.join(root, "spec/schema/v1.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const fixture = (name) => YAML.parse(readFileSync(path.join(root, "spec/fixtures/valid", name), "utf8"));
const example = (name) => YAML.parse(readFileSync(path.join(root, "examples", name, "otinstaller.yaml"), "utf8"));

// Real packages: a PyPI wheel whose hash ot checks, and Sigstore's keyless-signed cosign image.
const COSIGN_SIGNER = { identity: "keyless@projectsigstore.iam.gserviceaccount.com", issuer: "https://accounts.google.com" };
const digest = (c) => c.repeat(64);

const base = (over) => ({
  schema: 1,
  readme: "README.md",
  license: "MIT",
  outputs: [{ type: "account" }],
  ethics: { touches_target: false, auth_required: false, collects_personal_data: true },
  ...over,
});

// [manifest, extra facts about the package in the registry]
const packages = [
  [fixture("docker-tool.yaml"), { installs: 1200, stars: 40, health: "healthy", signed: true, repo: "https://github.com/dheeraj/holehe-lite",
    history: [["1.0.0", "removed", "Malicious dependency found in 1.0.0"], ["1.1.0", "published"]] }],
  [fixture("pipx-tool.yaml"), { installs: 300, stars: 12, health: "healthy", signed: true }],
  [fixture("guide.yaml"), { installs: 0, stars: 25, health: "not_checked", related: ["dheeraj/holehe-lite"] }],
  [base({
    name: "sherlock", namespace: "osintverse-community", version: "0.15.0",
    summary: "Finds accounts by username across 400+ social networks",
    categories: ["username", "social-media"],
    inputs: [{ name: "username", type: "username", required: true }],
    runtime: { kind: "docker", image: `ghcr.io/osintverse-community/sherlock@sha256:${digest("a")}`, platforms: ["linux/amd64"],
      command: ["sherlock", "--json", "{username}"], output_format: "json" },
    test: { input: { username: "example" } },
  }), { installs: 5000, stars: 300, health: "healthy", signed: true, community: true }],
  [base({
    name: "email-header-parser", namespace: "osintverse", version: "1.0.0",
    summary: "Parses raw email headers into hops, IP addresses and authentication results",
    categories: ["email", "utilities"],
    inputs: [{ name: "headers", type: "string", required: true }],
    outputs: [{ type: "ip" }, { type: "domain" }, { type: "email" }],
    runtime: { kind: "docker", image: `ghcr.io/osintverse/email-header-parser@sha256:${digest("b")}`, platforms: ["linux/amd64", "linux/arm64"],
      command: ["parse-headers", "{headers}"], output_format: "json" },
    ethics: { touches_target: false, auth_required: false, collects_personal_data: false },
  }), { installs: 900, stars: 60, health: "healthy", signed: true }],
  [base({
    name: "whois-lite", namespace: "dheeraj", version: "2.0.0",
    summary: "WHOIS and RDAP lookups for a domain with registrar and dates",
    categories: ["domain-dns"],
    inputs: [{ name: "domain", type: "domain", required: true }],
    outputs: [{ type: "organization" }, { type: "email" }],
    runtime: { kind: "docker", image: `ghcr.io/dheeraj/whois-lite@sha256:${digest("c")}`, platforms: ["linux/amd64"],
      command: ["whois-lite", "{domain}"], output_format: "json" },
  }), { installs: 900, stars: 60, health: "healthy", manifestHeld: true }],
  [base({
    name: "old-username-scraper", namespace: "dheeraj", version: "0.9.0",
    summary: "Scrapes username availability from a dozen forums (unmaintained)",
    categories: ["username"],
    inputs: [{ name: "username", type: "username", required: true }],
    runtime: { kind: "docker", image: `ghcr.io/dheeraj/old-username-scraper@sha256:${digest("d")}`, platforms: ["linux/amd64"],
      command: ["scrape", "{username}"], output_format: "json" },
    secrets: [{ name: "FORUM_API_KEY", required: true }],
  }), { installs: 900, stars: 60, health: "broken" }],
  [example("tldextract"), { installs: 700, stars: 90, health: "healthy", community: true }],
  [example("cosign"), { installs: 50, stars: 5, health: "healthy", signer: COSIGN_SIGNER }],
  // Same image, but the registry recorded a different signer: ot must refuse to install it.
  [{ ...example("cosign"), name: "cosign-wrong-signer", summary: "Test fixture whose recorded signer does not match the image" },
    { installs: 0, stars: 0, health: "healthy", signer: { identity: "attacker@example.com", issuer: "https://accounts.google.com" } }],
  [base({
    name: "secret-tool", namespace: "newbie", version: "0.1.0",
    summary: "A tool from a namespace that is still waiting for review",
    categories: ["username"],
    inputs: [{ name: "username", type: "username", required: true }],
    runtime: { kind: "docker", image: `ghcr.io/newbie/secret-tool@sha256:${digest("e")}`, platforms: ["linux/amd64"],
      command: ["x", "{username}"], output_format: "json" },
  }), { installs: 0, stars: 0, health: "unknown" }],
];

const namespaces = [
  ["ns_dheeraj", "github", "1001", "dheeraj", "user", "active", 0],
  ["ns_osintverse", "github", "1002", "osintverse", "org", "active", 1],
  ["ns_community", "registry", "community", "osintverse-community", "org", "active", 1],
  ["ns_newbie", "github", "1003", "newbie", "user", "pending_review", 0],
  ["ns_sigstore", "github", "1004", "sigstore", "org", "active", 1],
];

const PARAMETER_TYPES = new Set(["string", "integer", "boolean", "enum"]);
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;

function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  return { semver_major: +m[1], semver_minor: +m[2], semver_patch: +m[3], semver_pre: m[4] ?? "" };
}

/** Returns SQL statements that load the demo data into an empty database. */
export function buildSeedStatements(now = Date.UTC(2026, 9, 1)) {
  const out = [];
  for (const [id, provider, owner, name, kind, status, verified] of namespaces) {
    out.push(insert("namespaces", { id, provider, provider_owner_id: owner, name, kind, status, verified, created_at: now }));
  }
  const nsId = Object.fromEntries(namespaces.map((n) => [n[3], n[0]]));
  const toolIds = {};
  for (const [m, facts] of packages) {
    if (!validate(m)) throw new Error(`${m.namespace}/${m.name} is invalid: ${ajv.errorsText(validate.errors)}`);
    const toolId = `tool_${m.namespace}_${m.name}`;
    toolIds[`${m.namespace}/${m.name}`] = toolId;
    const latestId = `ver_${m.namespace}_${m.name}_${m.version}`;
    const readme = `${m.title ?? m.name}. ${m.summary}`;
    out.push(insert("tools", {
      id: toolId, namespace_id: nsId[m.namespace], kind: m.kind ?? "tool", name: m.name, summary: m.summary,
      categories: JSON.stringify(m.categories), tags: JSON.stringify(m.tags ?? []), repo_url: facts.repo ?? null,
      latest_version_id: latestId, community_packaged: facts.community ? 1 : 0, stars_count: facts.stars,
      installs_30d: facts.installs, health_status: facts.health, readme_text: readme, created_at: now, updated_at: now,
    }));
    const signer = facts.signer?.identity ?? (facts.signed ? `https://github.com/${m.namespace}/${m.name}/.github/workflows/otinstaller-release.yml@refs/tags/v${m.version}` : null);
    const issuer = facts.signer?.issuer ?? "https://token.actions.githubusercontent.com";
    const versions = [...(facts.history ?? []), [m.version, "published"]];
    versions.forEach(([version, status, reason], i) => {
      const manifest = { ...m, version };
      out.push(insert("versions", {
        id: `ver_${m.namespace}_${m.name}_${version}`, tool_id: toolId, version, ...semver(version),
        manifest_json: JSON.stringify(manifest), runtime_kind: m.runtime?.kind ?? null,
        artifact_ref: m.runtime?.image ?? (m.runtime?.wheel_sha256 ? `sha256:${m.runtime.wheel_sha256}` : null),
        signer_identity: signer, signer_issuer: signer ? issuer : null,
        scan_status: "pass", status, removed_reason: reason ?? null, published_at: now - (versions.length - i) * 86400000, created_at: now,
      }));
    });
    // Only entity inputs are searchable; string/integer/boolean/enum are plain parameters.
    for (const inp of (m.inputs ?? []).filter((i) => !PARAMETER_TYPES.has(i.type))) out.push(`INSERT OR IGNORE INTO tool_io VALUES (${q(toolId)}, 'in', ${q(inp.type)});`);
    for (const t of m.topics ?? []) out.push(`INSERT OR IGNORE INTO tool_io VALUES (${q(toolId)}, 'in', ${q(t)});`);
    for (const o of m.outputs ?? []) out.push(`INSERT OR IGNORE INTO tool_io VALUES (${q(toolId)}, 'out', ${q(o.type)});`);
    for (const s of m.secrets ?? []) out.push(insert("tool_secrets", { tool_id: toolId, name: s.name, required: s.required ? 1 : 0 }));
    if (facts.manifestHeld) {
      out.push(insert("sources", { id: `src_${m.name}`, tool_id: toolId, provider: "github", project_id: `${m.namespace}/${m.name}`,
        url: `https://github.com/${m.namespace}/${m.name}`, manifest_mode: "registry", registry_manifest_json: JSON.stringify(m) }));
    }
  }
  for (const [m, facts] of packages) {
    for (const rel of facts.related ?? []) {
      out.push(insert("tool_guides", { guide_id: toolIds[`${m.namespace}/${m.name}`], tool_id: toolIds[rel] }));
    }
  }
  // holehe-lite was a community wrapper before its owner claimed it.
  out.push(insert("aliases", { old_namespace: "osintverse-community", old_name: "holehe", tool_id: toolIds["dheeraj/holehe-lite"], created_at: now }));
  return out;
}
