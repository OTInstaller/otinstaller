// Editing one top-level key of an otinstaller.yaml as text, so the import wizard's forms can write their part of
// the draft without a YAML parser in the browser. A top-level block runs from `key:` at column 0 to the next
// line that starts at column 0 (or the end). Values are quoted when YAML would otherwise read them differently.

const KEY = /^[a-z_]+:/;

/** The lines of the block for `key`, or null when the key is absent. */
export function topLevelBlock(yaml: string, key: string): { start: number; end: number } | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(KEY.test(lines[end]!) || lines[end]!.startsWith("#") && !lines[end]!.startsWith(" "))) end++;
  return { start, end };
}

/** The draft with `key`'s block replaced by `block` (which starts with `key:`), or appended when absent. */
export function setTopLevel(yaml: string, key: string, block: string): string {
  const lines = yaml.replace(/\s+$/, "").split("\n");
  const pos = topLevelBlock(yaml, key);
  const body = block.replace(/\s+$/, "").split("\n");
  if (pos) lines.splice(pos.start, pos.end - pos.start, ...body);
  else lines.push(...body);
  return lines.join("\n") + "\n";
}

/** A YAML scalar: bare when safe, double-quoted otherwise. */
export function scalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  if (/^[A-Za-z0-9_][A-Za-z0-9_./+ -]*$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v) && !/^\d/.test(v) && !/ {2}/.test(v)) return v;
  return JSON.stringify(v);
}

export interface InputField { name: string; type: string; required: boolean; description?: string }

export function inputsBlock(inputs: InputField[]): string {
  if (inputs.length === 0) return "inputs: []";
  return ["inputs:", ...inputs.flatMap((i) => [`  - name: ${scalar(i.name)}`, `    type: ${i.type}`, `    required: ${i.required}`, ...(i.description ? [`    description: ${scalar(i.description)}`] : [])])].join("\n");
}

export function outputsBlock(types: string[]): string {
  if (types.length === 0) return "outputs: []";
  return ["outputs:", ...types.map((t) => `  - type: ${t}`)].join("\n");
}

export function ethicsBlock(e: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean }): string {
  return ["ethics:", `  touches_target: ${e.touches_target}`, `  auth_required: ${e.auth_required}`, `  collects_personal_data: ${e.collects_personal_data}`].join("\n");
}

export function categoriesBlock(cats: string[]): string {
  return cats.length ? ["categories:", ...cats.map((c) => `  - ${c}`)].join("\n") : "categories: []";
}

export function testBlock(input: Record<string, string>): string {
  const keys = Object.keys(input).filter((k) => input[k] !== "");
  if (keys.length === 0) return "test:\n  input: {}";
  return ["test:", "  input:", ...keys.map((k) => `    ${scalar(k)}: ${scalar(input[k]!)}`)].join("\n");
}

export function secretsBlock(secrets: { name: string; required: boolean; url?: string; description?: string }[]): string {
  if (secrets.length === 0) return "secrets: []";
  return ["secrets:", ...secrets.flatMap((s) => [`  - name: ${s.name}`, `    required: ${s.required}`, ...(s.url ? [`    url: ${scalar(s.url)}`] : []), ...(s.description ? [`    description: ${scalar(s.description)}`] : [])])].join("\n");
}

/** The top-level key a validator problem path points at ("/inputs/0/type" → "inputs"). */
export function problemKey(path: string | undefined): string | null {
  const m = path?.match(/^\/?([a-z_]+)/);
  return m ? m[1]! : null;
}
