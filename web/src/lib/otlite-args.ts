// How otlite turns typed inputs into a tool's own arguments (`_build_tool_args` in otlite's cli.py), and shell quoting
// for showing and copying commands. Pure and catalog-free, because the otlite tool pages' browser script imports it.

/** One typed input: the tool's flag words for it (empty means positional) and the value. */
export interface ArgPart {
  flag: string;
  value: string;
}

/** What the tool receives: its default arguments, then each input's flag words followed by the value. */
export function toolArgs(defaultArgs: readonly string[], parts: readonly ArgPart[]): string[] {
  const args = [...defaultArgs];
  for (const p of parts) {
    if (p.flag) args.push(...p.flag.split(" "), p.value);
    else args.push(p.value);
  }
  return args;
}

/** A word as it is typed in a POSIX shell: bare when that is safe, otherwise single-quoted. */
export function shellQuote(word: string): string {
  if (word === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Words joined into one shell line. */
export const shellLine = (words: readonly string[]) => words.map(shellQuote).join(" ");

/** The `otlite run` line for typed inputs, each written as prefix:value. */
export function runLine(name: string, parts: readonly { prefix: string; value: string }[]): string {
  return `otlite run ${name} -- ${parts.map((p) => shellQuote(`${p.prefix}:${p.value}`)).join(" ")}`;
}
