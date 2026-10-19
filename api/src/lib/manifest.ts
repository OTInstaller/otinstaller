// Server-side manifest validation. Mirrors cli/internal/manifest so the registry and `ot validate`
// report the same error codes for the same manifest.
import { Validator, type OutputUnit } from "@cfworker/json-schema";
import YAML from "yaml";
import schema from "../../../spec/schema/v1.json";

export const MAX_SIZE = 64 * 1024;

export interface Problem {
  code: string;
  path?: string;
  message: string;
  hint?: string;
}

export interface Manifest {
  schema: number;
  kind?: "tool" | "guide";
  name: string;
  namespace: string;
  version: string;
  summary: string;
  readme?: string;
  license: string;
  categories: string[];
  tags?: string[];
  inputs?: { name: string; type: string; required: boolean; default?: unknown }[];
  outputs?: { type: string }[];
  runtime?: {
    kind: "docker" | "pipx";
    command: string[];
    image?: string;
    platforms?: string[];
    package?: string;
    package_version?: string;
    wheel_sha256?: string;
    output_format: string;
  };
  secrets?: { name: string; required: boolean }[];
  test?: { input: Record<string, unknown> };
  docs?: { root: string; nav: string[] };
  content?: { root: string; nav: string[] };
  title?: string;
  related_tools?: string[];
  topics?: string[];
  [k: string]: unknown;
}

const validator = new Validator(schema as any, "2020-12", false);

const HINTS: Record<string, string> = {
  manifest_schema_version: "this registry understands schema: 1",
  manifest_name_invalid: "use 3-40 lowercase letters, digits and hyphens, not starting or ending with a hyphen",
  manifest_version_invalid: "use semver without a leading v, e.g. 1.2.0",
  manifest_license_invalid: "use an SPDX identifier such as MIT or Apache-2.0",
  manifest_image_not_pinned: "pin the image by digest (image@sha256:...); the release workflow from `ot init` does this",
  manifest_platform_missing: "every image must include linux/amd64",
};

function codeFor(loc: string): string {
  if (loc === "/schema") return "manifest_schema_version";
  if (loc === "/name" || loc === "/namespace") return "manifest_name_invalid";
  if (loc === "/version") return "manifest_version_invalid";
  if (loc === "/license") return "manifest_license_invalid";
  if (loc === "/runtime/image") return "manifest_image_not_pinned";
  if (loc.startsWith("/runtime/platforms")) return "manifest_platform_missing";
  return "manifest_schema";
}

// Keywords that only wrap their sub-schemas' errors; the leaves underneath say what is wrong.
const WRAPPERS = new Set(["properties", "items", "allOf", "anyOf", "oneOf", "$ref", "if", "then", "else", "prefixItems", "additionalProperties", "unevaluatedProperties"]);

function schemaProblems(errors: OutputUnit[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const e of errors) {
    if (WRAPPERS.has(e.keyword)) continue;
    const loc = e.instanceLocation.replace(/^#/, "");
    const key = `${loc}|${e.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = codeFor(loc);
    out.push({ code, path: loc || undefined, message: e.error, hint: HINTS[code] });
  }
  if (out.length === 0) out.push({ code: "manifest_schema", message: errors[0]?.error ?? "manifest does not match the schema" });
  // Most specific codes first, then deepest location, as the CLI does.
  return out.sort((a, b) => {
    const ga = a.code === "manifest_schema", gb = b.code === "manifest_schema";
    if (ga !== gb) return ga ? 1 : -1;
    return (b.path?.length ?? 0) - (a.path?.length ?? 0);
  });
}

export function parseManifest(text: string): { manifest?: Manifest; problems: Problem[] } {
  if (new TextEncoder().encode(text).length > MAX_SIZE) {
    return { problems: [{ code: "manifest_too_large", message: `manifest is larger than ${MAX_SIZE} bytes` }] };
  }
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return { problems: [{ code: "manifest_yaml_invalid", message: (e as Error).message, hint: "check indentation and quoting" }] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { problems: [{ code: "manifest_yaml_invalid", message: "manifest must be a YAML mapping" }] };
  }
  // Round-trip through JSON so YAML-only values (dates, etc.) behave as they do in the CLI.
  doc = JSON.parse(JSON.stringify(doc));
  const r = validator.validate(doc);
  if (!r.valid) return { problems: schemaProblems(r.errors) };
  const manifest = doc as Manifest;
  manifest.kind ??= "tool";
  return { manifest, problems: semanticProblems(manifest) };
}

const PLACEHOLDER = /\{([^{}]*)\}/g;

export function semanticProblems(m: Manifest): Problem[] {
  const ps: Problem[] = [];
  const inputs = new Set<string>();
  (m.inputs ?? []).forEach((inp, i) => {
    if (inputs.has(inp.name)) ps.push({ code: "manifest_input_duplicate", path: `/inputs/${i}/name`, message: `input "${inp.name}" is declared more than once` });
    inputs.add(inp.name);
  });
  const secrets = new Set<string>();
  (m.secrets ?? []).forEach((s, i) => {
    if (secrets.has(s.name)) ps.push({ code: "manifest_secret_duplicate", path: `/secrets/${i}/name`, message: `secret "${s.name}" is declared more than once` });
    secrets.add(s.name);
  });
  (m.runtime?.command ?? []).forEach((arg, i) => {
    for (const [, name] of arg.matchAll(PLACEHOLDER)) {
      if (!inputs.has(name!)) {
        ps.push({ code: "manifest_placeholder_unknown", path: `/runtime/command/${i}`, message: `command uses {${name}} but no input is named ${name}`, hint: "rename the input or the placeholder" });
      }
    }
  });
  if (m.test) {
    for (const k of Object.keys(m.test.input).sort()) {
      if (!inputs.has(k)) ps.push({ code: "manifest_test_input_unknown", path: `/test/input/${k}`, message: `test input "${k}" is not a declared input` });
    }
    for (const inp of m.inputs ?? []) {
      if (inp.required && !(inp.name in m.test.input)) {
        ps.push({ code: "manifest_test_input_missing", path: "/test/input", message: `required input "${inp.name}" has no test value` });
      }
    }
  }
  return ps;
}

/** Files the manifest refers to, relative to the repository root. */
export function referencedFiles(m: Manifest): { path: string; field: string }[] {
  const files: { path: string; field: string }[] = [];
  if (m.readme) files.push({ path: m.readme, field: "/readme" });
  for (const [field, pages] of [["/docs", m.docs], ["/content", m.content]] as const) {
    pages?.nav.forEach((p, i) => files.push({ path: pages.root + p, field: `${field}/nav/${i}` }));
  }
  return files;
}

export function semverParts(v: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  if (!m) throw new Error(`not semver: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}
