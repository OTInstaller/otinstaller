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
  inputs?: { name: string; type: string; required: boolean; default?: unknown; values?: string[]; example?: unknown; description?: string }[];
  outputs?: { type: string; description?: string; attrs?: { name: string; type: string; description?: string }[] }[];
  runtime?: {
    kind: "docker" | "pipx";
    command: string[];
    image?: string;
    platforms?: string[];
    package?: string;
    package_version?: string;
    wheel_sha256?: string;
    output_format: string;
    timeout_seconds?: number;
    typical_seconds?: number;
  };
  secrets?: { name: string; required: boolean; description?: string; url?: string; pricing?: "free" | "free_tier" | "paid" }[];
  ethics?: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean; notifies_target?: boolean; notes?: string };
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
    if (inp.example !== undefined) {
      const why = exampleProblem(inp);
      if (why) ps.push({ code: "manifest_example_invalid", path: `/inputs/${i}/example`, message: `the example for "${inp.name}" ${why}`, hint: "give a value of the input's type, as a user would type it" });
    }
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

/** "a" or "an" before an input type, as `article` in the CLI. */
const article = (t: string) => (/^[aeio]/.test(t) ? `an ${t}` : `a ${t}`);

/** What is wrong with an input's example, or "" when it suits the input's type (as `exampleProblem` in the CLI). */
function exampleProblem(inp: { type: string; values?: string[]; example?: unknown }): string {
  const v = inp.example;
  if (typeof v === "boolean") return inp.type === "boolean" ? "" : `is true or false, but the input is ${article(inp.type)}`;
  if (typeof v === "number") {
    if (inp.type !== "integer") return `is a number, but the input is ${article(inp.type)}; quote it if it is text`;
    return Number.isInteger(v) ? "" : "is not a whole number";
  }
  if (typeof v === "string") {
    if (v.trim() === "") return "is empty";
    if (inp.type === "integer" || inp.type === "boolean") return `is text, but the input is ${article(inp.type)}`;
    if (inp.type === "enum" && !(inp.values ?? []).includes(v)) return `is "${v}", which is not one of its values`;
    if (inp.type === "email" && (!v.includes("@") || /[ \t]/.test(v))) return `"${v}" is not an email address`;
    return "";
  }
  return "must be a single value, not a list or a map";
}

/**
 * The manifest without the optional fields added after ot v0.12 (input examples, output descriptions and attributes,
 * typical_seconds, secret pricing, notifies_target and notes). ot v0.12 validates the manifest it installs against
 * its own schema, which rejects fields it doesn't know, so the install endpoint serves this as `manifest` and the
 * whole one as `manifest_full`. Add every new optional field here. Returns null when nothing had to be left out.
 */
export function compatManifest(m: Record<string, any>): Record<string, any> | null {
  const c = structuredClone(m);
  let changed = false;
  const drop = (o: Record<string, any> | undefined, ...keys: string[]) => {
    for (const k of keys) if (o && k in o) { delete o[k]; changed = true; }
  };
  for (const i of c.inputs ?? []) drop(i, "example");
  for (const o of c.outputs ?? []) drop(o, "description", "attrs");
  drop(c.runtime, "typical_seconds");
  for (const s of c.secrets ?? []) drop(s, "pricing");
  drop(c.ethics, "notifies_target", "notes");
  return changed ? c : null;
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
