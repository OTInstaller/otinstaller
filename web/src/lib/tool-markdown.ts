// Markdown twins of tool and guide pages (/<ns>/<name>.md, /guides/<ns>/<name>/<page>.md), built from API responses.
import { API_URL, SITE_URL, type Manifest, type Page, type ToolDetail } from "./api";

type Input = NonNullable<Manifest["inputs"]>[number];

/** The typed-input prefixes `ot run` understands (`u:johndoe`), by input type. */
const PREFIXES: Record<string, string> = { username: "u", domain: "d", email: "e", phone: "p", ip: "ip", url: "url" };

/** Example values by input type, used when the manifest's test input has none. */
const EXAMPLES: Record<string, string> = {
  username: "johndoe", domain: "example.com", email: "jane@example.com", phone: "+14155550123", ip: "192.0.2.10",
  url: "https://example.com", name: "Jane Doe", company: "Example Ltd", crypto_address: "bc1qexampleaddress",
  hash: "d41d8cd98f00b204e9800998ecf8427e", image: "photo.jpg", integer: "10", boolean: "true",
};

/** Input types that identify a person: a run given one always asks first (as ot's consent classes do). */
const PERSONAL_INPUTS = new Set(["email", "phone", "name", "image"]);

/** The consent docs, linked from every tool twin. */
const CONSENT_DOCS = `${SITE_URL}/docs/agents#consent`;

/** A plausible value for an input: the manifest's test input, its default, its first enum value, else by type. */
function example(m: Manifest, input: Input): string {
  if (input.example !== undefined && input.example !== null && input.example !== "") return String(input.example);
  const test = m.test?.input?.[input.name];
  if (test !== undefined && test !== null && test !== "") return String(test);
  if (input.default !== undefined && input.default !== null) return String(input.default);
  if (input.values?.length) return input.values[0];
  return EXAMPLES[input.type] ?? "value";
}

/** Quotes a shell argument only when it needs it. */
function arg(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `ot run` examples: one per input type with a typed prefix (when only one input has that type), else flags. */
export function runLines(ref: string, m: Manifest): string[] {
  const inputs = m.inputs ?? [];
  const required = inputs.filter((i) => i.required);
  const flags = (skip?: Input) => required.filter((i) => i !== skip).map((i) => `--${i.name} ${arg(example(m, i))}`);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const prefix = PREFIXES[input.type];
    if (!prefix || seen.has(input.type)) continue;
    seen.add(input.type);
    // ot refuses a typed input when several inputs share the type, so those get flags below.
    if (inputs.filter((i) => i.type === input.type).length > 1) continue;
    lines.push(["ot run", ref, `${prefix}:${arg(example(m, input))}`, ...flags(input)].join(" "));
  }
  if (!lines.length) lines.push(["ot run", ref, ...flags()].join(" "));
  return lines;
}

/** The MCP `run_tool` call with the required inputs (or the first input when none is required). */
export function mcpCall(ref: string, m: Manifest): string {
  const inputs = m.inputs ?? [];
  const pick = inputs.some((i) => i.required) ? inputs.filter((i) => i.required) : inputs.slice(0, 1);
  const values: Record<string, unknown> = {};
  for (const i of pick) {
    const v = example(m, i);
    values[i.name] = i.type === "integer" && /^-?\d+$/.test(v) ? Number(v) : i.type === "boolean" ? v === "true" : v;
  }
  return `run_tool ${JSON.stringify({ tool: ref, inputs: values })}`;
}

/** Whether a run can need the person's consent, and why, following ot's consent classes. */
export function consent(m: Manifest): { needed: boolean; text: string } {
  const e = m.ethics;
  const egress = m.network?.egress === true;
  const personalInputs = (m.inputs ?? []).filter((i) => PERSONAL_INPUTS.has(i.type));
  const usesKeys = !!e?.auth_required || (m.secrets ?? []).some((s) => s.required);
  if (!e || e.touches_target || e.collects_personal_data || usesKeys || egress) {
    const why = !e || e.touches_target ? "it contacts the target"
      : e.collects_personal_data ? "it collects personal data"
      : usesKeys ? "it uses the person's own account or API key"
      : "it goes online";
    return { needed: true, text: `An agent needs the person's consent before running this tool, because ${why}. See ${CONSENT_DOCS}.` };
  }
  if (personalInputs.length) {
    const names = personalInputs.map((i) => `\`${i.name}\``).join(", ");
    return { needed: true, text: `This tool is passive, but a run given ${names} (an identifier of a person) needs the person's consent. See ${CONSENT_DOCS}.` };
  }
  return { needed: false, text: `This tool is passive, so an agent can run it without asking. See ${CONSENT_DOCS}.` };
}

/** What a run does, in plain words, from the ethics flags and network access. */
export function behaviour(m: Manifest): string[] {
  const e = m.ethics;
  const out = [
    !e || e.touches_target ? "Contacts the target directly (sends requests to sites or services about it)." : "Does not contact the target.",
    e?.collects_personal_data ? "Collects personal data." : "Does not collect personal data.",
    e?.auth_required ? "Needs an account (it logs in, or uses an account or API key of yours)." : "Does not need an account.",
  ];
  if (e?.notifies_target === true) out.push("May notify the target (a sign-up or reset email, a login alert).");
  else if (e?.notifies_target === false) out.push("Does not notify the target.");
  else if (!e || e.touches_target) out.push("May notify the target (the publisher doesn't say).");
  if (m.runtime?.typical_seconds) out.push(`Usually takes about ${m.runtime.typical_seconds} seconds.`);
  if (e?.notes) out.push(`Publisher's note: ${e.notes}`);
  if (m.network?.egress) out.push(m.network.domains?.length ? `Connects to ${m.network.domains.join(", ")}.` : "Connects to the internet.");
  else out.push("Runs offline (no network access).");
  return out;
}

/** A table cell: no pipes or line breaks. */
const cell = (v: unknown) => (v === undefined || v === null || v === "" ? "" : String(v).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " "));

const yes = (v: boolean) => (v ? "yes" : "no");

/** The Markdown twin of a tool page (or, for a guide, a pointer to its pages). */
export function toolMarkdown(t: ToolDetail): string {
  const ref = `${t.namespace}/${t.name}`;
  const m = t.manifest;
  const page = `${SITE_URL}/${ref}`;
  const json = `${API_URL}/v1/tools/${ref}`;
  if (t.kind === "guide") return guidePointer(t);

  const parts: string[] = [`# ${ref}`, t.summary];
  if (t.deprecated_message || t.status === "deprecated") {
    parts.push(`**Deprecated.** ${t.deprecated_message ?? ""}${t.deprecated_replacement ? ` Use ${t.deprecated_replacement} instead.` : ""}`.trim());
  }

  parts.push("## Install and run", ["```sh", `ot install ${ref}`, ...runLines(ref, m), "```"].join("\n"));
  parts.push("The first `ot run` installs the tool after asking once. New to `ot`? See " + `${SITE_URL}/docs/getting-started.`);
  parts.push("From an AI agent, through ot's MCP server (`ot mcp`):", ["```", mcpCall(ref, m), "```"].join("\n"));

  const inputs = m.inputs ?? [];
  if (inputs.length) {
    const rows = inputs.map((i) => `| \`${i.name}\` | ${cell(i.type === "enum" && i.values?.length ? `enum (${i.values.join(", ")})` : i.type)} | ${yes(i.required)} | ${i.default === undefined ? "" : `\`${cell(i.default)}\``} | ${cell(i.description)} |`);
    parts.push("## Inputs", ["| Name | Type | Required | Default | Description |", "| --- | --- | --- | --- | --- |", ...rows].join("\n"));
  } else {
    parts.push("## Inputs", "None.");
  }
  const outputs = m.outputs ?? [];
  parts.push("## Outputs", outputs.length ? `Finds: ${outputs.map((o) => o.type).join(", ")}.` : "No entity types declared.");
  const detail = outputs.filter((o) => o.description || o.attrs?.length).map((o) => {
    const attrs = (o.attrs ?? []).map((a) => `\n  - \`${a.name}\` (${a.type})${a.description ? `: ${a.description}` : ""}`).join("");
    return `- \`${o.type}\`${o.description ? `: ${o.description}` : ""}${attrs}`;
  });
  if (detail.length) parts.push(detail.join("\n"));

  const c = consent(m);
  parts.push("## What a run does", [...behaviour(m).map((s) => `- ${s}`)].join("\n"), c.text);

  const secrets = m.secrets ?? [];
  if (secrets.length) {
    const lines = secrets.map((s) => `- \`${s.name}\` (${s.required ? "required" : "optional"}${s.pricing ? `, ${s.pricing.replace("_", " ")}` : ""})${s.description ? `: ${s.description}` : ""}${s.url ? ` Get one at ${s.url}` : ""}`);
    parts.push("## API keys", [...lines, "", "Store a key with `ot keys set NAME`; it stays in the OS keychain."].join("\n"));
  }

  const trust = [
    `- Latest version: ${t.latest_version}`,
    `- Signed: ${yes(t.signed)}`,
    `- Verified publisher: ${yes(t.verified)}`,
    `- Health: ${t.health.replace(/_/g, " ")}`,
    `- Installs in the last 30 days: ${t.installs_30d}`,
    `- License: ${t.license}`,
  ];
  if (t.runtime) trust.push(`- Runtime: ${t.runtime === "docker" ? "Docker image, pinned by digest" : "Python wheel (pipx), pinned by hash"}`);
  if (t.repo_url) trust.push(`- Repository: ${t.repo_url}`);
  if (t.community_packaged) trust.push("- Packaged by the community from a third-party tool");
  parts.push("## Trust", trust.join("\n"));

  const links = [`- Web page: ${page}`, `- JSON: ${json}`];
  if (m.docs?.nav?.length) links.push(`- Docs: ${page}/docs`);
  if (m.readme) links.push(`- README: ${t.repo_url ? `${t.repo_url.replace(/\/+$/, "")}#readme` : `${json}/readme`}`);
  if (t.homepage && t.homepage !== t.repo_url) links.push(`- Homepage: ${t.homepage}`);
  links.push(`- Security details: ${page}/security`);
  // Where someone (or an agent, for them) says it is broken, out of date or wrong.
  links.push(`- Report a problem: ${page}/report`);
  parts.push("## Links", links.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/** A guide asked for at /<ns>/<name>.md: where its pages are. */
function guidePointer(t: ToolDetail): string {
  const ref = `${t.namespace}/${t.name}`;
  const base = `${SITE_URL}/guides/${ref}`;
  const nav = t.manifest.content?.nav ?? [];
  const parts = [`# ${ref}`, t.title ? `${t.title}. ${t.summary}` : t.summary, `This is a guide, not a tool. Read it as Markdown at ${base}.md, or offline with \`ot guide get ${ref}\`.`];
  if (nav.length) parts.push("## Pages", nav.map((p) => `- ${base}/${p.replace(/\.md$/, "")}.md`).join("\n"));
  parts.push("## Links", [`- Web page: ${base}`, `- JSON: ${API_URL}/v1/guides/${ref}`].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/** A guide page's address on the site, with `.md` for the twin; the version only when it is not the latest. */
export function guidePageUrl(ref: string, path: string, version?: string, md = false): string {
  return `${SITE_URL}/guides/${ref}/${path.replace(/\.md$/, "")}${md ? ".md" : ""}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** The Markdown twin of a guide page: title, source, the body (relative .md links made absolute twins), next page. */
export function guidePageMarkdown(page: Page, version?: string): string {
  const here = guidePageUrl(page.ref, page.path, version, true);
  let body = page.body.replace(/\r\n/g, "\n").trim();
  // Most pages open with their own title; don't say it twice.
  const h1 = /^#\s+(.+)\n*/.exec(body);
  if (h1 && h1[1].trim() === page.title.trim()) body = body.slice(h1[0].length);
  body = body.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+?\.md)(#[^)\s]*)?\)/gi, (all, link: string, hash = "") => {
    try {
      const u = new URL(link, here);
      const path = u.pathname.replace(/^\/guides\/[^/]+\/[^/]+\//, "");
      return `](${guidePageUrl(page.ref, path, version, true)}${hash})`;
    } catch {
      return all;
    }
  });
  const parts = [`# ${page.title}`, `Source: ${guidePageUrl(page.ref, page.path, version)} (page ${page.position} of ${page.pages} of ${page.ref})`, body];
  if (page.next) parts.push(`Next: ${guidePageUrl(page.ref, page.next.path, version, true)}`);
  return `${parts.join("\n\n")}\n`;
}

/** A short Markdown body for a missing (404), removed (410) or unavailable (503) package. */
export function problemMarkdown(status: number, what: string, message?: string): string {
  const title = status === 410 ? "Removed" : status === 404 ? "Not found" : "Registry unavailable";
  const text =
    status === 410 ? (message ? `${message.replace(/\.?$/, ".")}` : `${what} was removed from the registry.`)
    : status === 404 ? `There is no ${what} in the registry. Search at ${SITE_URL}/search or ${API_URL}/v1/tools?q=...`
    : `The registry could not be reached. Try again in a minute.`;
  return `# ${title}\n\n${text}\n`;
}
