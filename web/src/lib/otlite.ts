// otlite's tools on the site: the catalog in data/otlite-catalog.json (written by otlite/scripts/web_catalog.py from
// otlite's registry), lookups and wording for the /otlite/tools/<name> pages, and each page's Markdown twin.
import catalog from "../data/otlite-catalog.json";
import type { MarkdownPage } from "./markdown";
import { shellQuote } from "./otlite-args";

// No tool needs a key today, so the JSON's `required` lists would type as never[]; say what they hold.
export type OtliteTool = Omit<(typeof catalog.tools)[number], "api_keys"> & { api_keys: { required: string[]; optional: string[] } };
export type OtliteInput = OtliteTool["inputs"][number];

export const OTLITE_TOOLS: OtliteTool[] = catalog.tools;
export const OTLITE_VERSION = catalog.otlite;
/** The responsible-use line otlite prints before installing a dual-use tool. */
export const OTLITE_NOTICE = catalog.notice;

/** What a tool accepts, as the catalog's filters say it. */
export const ACCEPT_LABELS: Record<string, string> = {
  username: "Username", email: "Email", phone: "Phone", domain: "Domain", ip: "IP address", url: "URL", name: "Name",
};

/** What each typed-input prefix stands for. */
export const PREFIX_LABELS: Record<string, string> = {
  u: "Username", e: "Email", d: "Domain", p: "Phone", url: "URL", ip: "IP address", q: "Search term", tg: "Telegram name",
  geo: "Coordinates", lat: "Latitude", lng: "Longitude",
};

/** The prefixes `otlite run --all` takes (otlite's cli.py). */
const BATCH_PREFIXES = new Set(["u", "e", "p", "d", "url", "ip"]);

export const toolPath = (name: string) => `/otlite/tools/${name}`;
export const findOtliteTool = (name: string) => OTLITE_TOOLS.find((t) => t.name === name);
export const repoUrl = (repo: string) => (repo.startsWith("http") ? repo : `https://github.com/${repo}`);
export const keysOf = (t: OtliteTool) => [...t.api_keys.required, ...t.api_keys.optional];
/** The command the tool itself is started with. */
export const toolCommand = (t: OtliteTool) => t.entrypoint.command ?? `python ${t.entrypoint.script}`;
/** The tool's own command line for the given arguments. */
export const receives = (t: OtliteTool, args: readonly string[]) => [toolCommand(t), ...args.map(shellQuote)].join(" ");
/** A tab's or row's name for one input entry: lat and lng together read as coordinates. */
export const inputLabel = (entry: OtliteInput) =>
  entry.parts.length > 1 ? "Coordinates" : (PREFIX_LABELS[entry.parts[0]!.prefix] ?? entry.parts[0]!.prefix);

/** The first sentence of a description, for titles and cards. */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (m ? m[1]! : text.trim()).replace(/[.!?]$/, "");
}

/** Where the pinned version lives: its PyPI release, or the commit a git install checks out. */
export function pin(t: OtliteTool): { label: string; short: string; url: string } {
  const i = t.install;
  if (i.method === "pip") {
    return { label: `${i.package}==${i.version}`, short: `pip ${i.version}`, url: `https://pypi.org/project/${i.package}/${i.version}/` };
  }
  const repo = (i.url ?? "").replace(/\.git$/, "");
  const ref = i.ref ?? "";
  const short = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
  return { label: `${repo.replace(/^https:\/\//, "")} at ${short}`, short: `git ${short}`, url: ref ? `${repo}/tree/${ref}` : repo };
}

/** "<3.13" as people say it. */
export function pythonRange(spec: string): string {
  const m = /^(<=|>=|==|!=|<|>)(.+)$/.exec(spec);
  if (!m) return spec;
  const words: Record<string, string> = { "<": `older than ${m[2]}`, "<=": `${m[2]} or older`, ">": `newer than ${m[2]}`, ">=": `${m[2]} or newer`, "==": `exactly ${m[2]}`, "!=": `other than ${m[2]}` };
  return words[m[1]!] ?? spec;
}

/** 2026-09-24 as 24 Sep 2026. */
export function verifiedOn(t: OtliteTool): string | null {
  if (!t.verified?.date) return null;
  const d = new Date(`${t.verified.date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? t.verified.date : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A caveat worth reading before running a tool. `text` is Markdown-lite: code spans and links (see InlineText). */
export interface OtliteNotice {
  kind: "info" | "warn";
  title: string;
  text: string;
}

/** The note that explains a tool's Python range ("Needs Python …, because …"): it becomes the Python caution's text. */
const pythonNote = (t: OtliteTool) => (t.requires_python ? t.notes.find((n) => n.startsWith("Needs Python")) : undefined);

/** A tool's notes, less the one already said by its Python caution. */
export const otherNotes = (t: OtliteTool) => t.notes.filter((n) => n !== pythonNote(t));

/** "NOASSERTION" is what the registry says when a project states no licence. */
export const licence = (t: OtliteTool) => (!t.license || t.license === "NOASSERTION" ? "Not stated" : t.license);

/** The caveats that follow from a tool's registry entry, most decisive first. Its other notes come separately. */
export function notices(t: OtliteTool): OtliteNotice[] {
  const out: OtliteNotice[] = [];
  if (t.dual_use) out.push({ kind: "info", title: "Dual-use.", text: `otlite prints this before installing it: ${OTLITE_NOTICE}` });
  if (t.interactive) out.push({ kind: "warn", title: "Asks questions while it runs.", text: "Run it on its own in a terminal; `otlite run --all`, `otlite auto` and playbooks skip it." });
  if (t.long_running) out.push({ kind: "warn", title: "Runs until you stop it.", text: "It monitors its target continuously and doesn't exit, so batch runs never start it." });
  if (t.needs_config) out.push({ kind: "warn", title: "Needs a login or API key.", text: "Set it up before the first lookup; batch runs skip it unless you pass `--include-credentialed`." });
  if (t.requires_python) {
    const why = pythonNote(t)?.replace(/^Needs Python [^,]+, because /, "");
    const reason = why ? `${why[0]!.toUpperCase()}${why.slice(1)} ` : "";
    out.push({ kind: "warn", title: `Needs Python ${pythonRange(t.requires_python)}.`, text: `${reason}otlite checks your Python before installing and says which version to use; \`otlite doctor\` lists the tools your Python can't run.` });
  }
  if (t.install.playwright_browsers.length) out.push({ kind: "info", title: "Downloads Chromium.", text: `The install also fetches a Chromium build for Playwright into the tool's own folder under \`~/.otlite/tools/${t.name}\`.` });
  if (t.run_from_source) out.push({ kind: "info", title: "Runs from its source folder.", text: "It reads data files by relative path, so otlite starts it inside its own checkout." });
  return out;
}

/** How the tool joins multi-tool runs: the commands that include it, or why they skip it. */
export function batchUse(t: OtliteTool): { all: string | null; auto: string | null; skip: string | null } {
  if (t.batch_skip) return { all: null, auto: null, skip: t.batch_skip };
  const entry = t.inputs.find((e) => e.parts.length === 1 && BATCH_PREFIXES.has(e.parts[0]!.prefix));
  if (!entry) return { all: null, auto: null, skip: null };
  const { prefix, sample } = entry.parts[0]!;
  const target = shellQuote(sample);
  return {
    all: `otlite run --all ${shellQuote(`${prefix}:${sample}`)}`,
    auto: prefix === "p" ? `otlite auto --type phone ${target}` : `otlite auto ${target}`,
    skip: null,
  };
}

/** The value a page's examples use for the target: the first input's sample, else a username. */
export const sampleTarget = (t: OtliteTool) => t.inputs[0]?.parts[0]?.sample ?? "johndoe";

/** Up to `n` other tools that take the same things, the closest overlap first, then the most starred. */
export function relatedTools(t: OtliteTool, n = 6): OtliteTool[] {
  const mine = new Set(t.accepts);
  return OTLITE_TOOLS.filter((o) => o.name !== t.name)
    .map((o) => ({ o, shared: o.accepts.filter((a) => mine.has(a)).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || (b.o.stars ?? 0) - (a.o.stars ?? 0) || a.o.display_name.localeCompare(b.o.display_name))
    .slice(0, n)
    .map((x) => x.o);
}

/** The tools before and after this one in the catalog's order (by display name). */
export function neighbours(t: OtliteTool): { prev: OtliteTool | null; next: OtliteTool | null } {
  const i = OTLITE_TOOLS.findIndex((o) => o.name === t.name);
  return { prev: OTLITE_TOOLS[i - 1] ?? null, next: OTLITE_TOOLS[i + 1] ?? null };
}

/** The files one run leaves, for the example target. */
export function resultFiles(t: OtliteTool): string[] {
  const dir = `results/${t.name}/${sampleTarget(t).replace(/[^\w.@-]+/g, "_")}`;
  const stem = `<time>_${t.name}_${sampleTarget(t).replace(/[^\w.@-]+/g, "_")}_<run id>`;
  return [`${dir}/${stem}.txt`, `${dir}/${stem}.meta.json`, `${dir}/${stem}.envelope.json`];
}

// ---------- Markdown twins ----------

const code = (s: string) => `\`${s}\``;
const cell = (s: string) => s.replace(/\|/g, "\\|");

function markdownBody(t: OtliteTool): string {
  const p = pin(t);
  const keys = keysOf(t);
  const batch = batchUse(t);
  const sections: string[] = [];

  sections.push(
    [
      `- Takes: ${t.accepts.map((a) => ACCEPT_LABELS[a] ?? a).join(", ") || "its own arguments"}`,
      `- Install: ${code(`otlite install ${t.name}`)}, into its own virtualenv`,
      `- Pinned: [${p.label}](${p.url})${t.install.extra_packages.length ? `, with ${t.install.extra_packages.map(code).join(", ")}` : ""}`,
      `- Command: ${code(toolCommand(t))}`,
      `- Python: ${t.requires_python ? pythonRange(t.requires_python) : "any otlite runs on (3.10 or newer)"}`,
      t.verified ? `- Verified: ${verifiedOn(t)}, version ${t.verified.version} on ${t.verified.os}, Python ${t.verified.python}` : "- Verified: not yet",
      `- Licence: ${licence(t)}${t.stars ? `; ${t.stars.toLocaleString("en-US")} GitHub stars` : ""}`,
      `- Source: ${repoUrl(t.repo)}`,
    ].join("\n"),
  );
  sections.push(`otlite is the no-Docker edition of OTInstaller for Linux and macOS: [install it](/otlite) with ${code("curl -fsSL https://get.otinstaller.com/otlite | sh")}.`);

  if (t.inputs.length) {
    const rows = t.inputs.map((e) => `| ${cell(inputLabel(e))} | ${cell(code(e.command))} | ${cell(code(receives(t, e.tool_args)))} |`);
    sections.push(`## Run it\n\n| Input | otlite command | ${cell(t.display_name)} receives |\n| --- | --- | --- |\n${rows.join("\n")}\n\nArguments after ${code("--")} that aren't typed inputs go to the tool unchanged.`);
  } else {
    sections.push(`## Run it\n\n${t.display_name} has no typed inputs: pass its own arguments after ${code("--")}, starting with ${code(`otlite run ${t.name} -- --help`)}.`);
  }

  const cautions = [...notices(t).map((n) => `- **${n.title}** ${n.text}`), ...otherNotes(t).map((n) => `- ${n}`)];
  if (cautions.length) sections.push(`## Before you run it\n\n${cautions.join("\n")}`);

  if (keys.length) {
    sections.push(
      `## API keys\n\n${keys.map((k) => `- ${code(k)} (${t.api_keys.required.includes(k) ? "required" : "optional"}): ${code(`otlite keys set ${k}`)}`).join("\n")}\n\nKeys live in ${code("~/.otlite/.env")}, readable only by you, and each tool receives only the keys it declares.`,
    );
  }

  sections.push(
    `## What a run leaves\n\n${resultFiles(t).map((f) => `- ${code(f)}`).join("\n")}\n\nThe envelope is the same shape for every tool: the tool and version, the input, timing, exit code and status, the emails, domains, IP addresses and URLs found in the output, and the output file's path, hash and size. ${code(`otlite results --tool ${t.name}`)} lists saved runs, ${code(`otlite extract ${t.name}`)} pulls out indicators and ${code(`otlite diff ${t.name} ${shellQuote(sampleTarget(t))}`)} compares the two latest runs.`,
  );

  const together = batch.skip
    ? `Batch runs skip it: ${batch.skip}.`
    : batch.all
      ? `${code(batch.all)} and ${code(batch.auto!)} run it with every other installed tool that takes the same input.`
      : "Batch runs can't pass it a value; run it on its own.";
  const plays = t.playbooks.map((pb) => `${code(`otlite playbook ${pb} ${shellQuote(sampleTarget(t))}`)}`);
  sections.push(`## With other tools\n\n${together}${plays.length ? ` It is in the ${t.playbooks.map(code).join(" and ")} playbook${plays.length > 1 ? "s" : ""}: ${plays.join(", ")}.` : ""}`);

  const related = relatedTools(t);
  if (related.length) sections.push(`## Related tools\n\n${related.map((r) => `- [${r.display_name}](${toolPath(r.name)}.md): ${firstSentence(r.description)}`).join("\n")}`);
  sections.push(`[All ${OTLITE_TOOLS.length} otlite tools](/otlite/tools) · [otlite docs](/docs/otlite.md)`);
  return sections.join("\n\n");
}

/** One Markdown twin per tool, served at /otlite/tools/<name>.md and to `Accept: text/markdown`. */
export const OTLITE_PAGES: MarkdownPage[] = OTLITE_TOOLS.map((t) => ({
  path: toolPath(t.name),
  slug: t.name,
  section: "site",
  title: `${t.display_name} (otlite)`,
  description: t.description,
  body: markdownBody(t),
}));
