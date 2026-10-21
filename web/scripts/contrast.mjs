// Checks the colour pairs in src/styles/tokens.css against WCAG 2.2 AA (4.5:1 for text, 3:1 for large text and
// status marks) in both themes. Run with `npm run contrast`; exits 1 on any failure.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const css = await readFile(fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)), "utf8");

function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 1;
  let i = open + 1;
  while (depth > 0) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    i++;
  }
  const vars = {};
  for (const m of css.slice(open, i).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const dark = block(":root {");
const light = block(':root[data-theme="light"]');
const themes = { dark, light: { ...dark, ...light } };

function parse(c, bg) {
  c = c.trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = c.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+)%)?\)$/);
  if (m) {
    const rgb = [+m[1], +m[2], +m[3]];
    if (!m[4] || !bg) return rgb;
    const a = +m[4] / 100;
    return rgb.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  }
  throw new Error(`cannot parse ${c}`);
}
const lum = ([r, g, b]) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// [foreground, background, minimum, note]
const pairs = [
  ["text", "bg", 4.5], ["text", "bg-subtle", 4.5], ["text", "bg-raised", 4.5],
  ["text-muted", "bg", 4.5], ["text-muted", "bg-subtle", 4.5], ["text-muted", "bg-raised", 4.5],
  ["text-faint", "bg", 4.5, "11–12 px labels"], ["text-faint", "bg-subtle", 4.5], ["text-faint", "bg-raised", 4.5],
  ["ok", "bg", 4.5], ["ok", "ok-soft", 4.5], ["warn", "bg", 4.5], ["warn", "warn-soft", 4.5], ["bad", "bg", 4.5], ["bad", "bad-soft", 4.5], ["info", "bg", 4.5],
  ["action-text", "action", 4.5, "primary button"], ["action-strong-text", "action-strong", 4.5, "strong button"],
  ["bg", "bg-inverse", 4.5, "selected chip"], ["accent-contrast", "accent", 4.5],
  ["code-text", "code-bg", 4.5], ["code-text", "code-raised", 4.5], ["code-muted", "code-bg", 4.5], ["code-muted", "code-raised", 4.5], ["code-accent", "code-raised", 4.5], ["code-warn", "code-raised", 4.5], ["code-ok", "code-bg", 4.5],
  ["border-strong", "bg", 3, "control borders"],
];

let failed = 0;
for (const [name, t] of Object.entries(themes)) {
  for (const [fg, bg, min, note] of pairs) {
    const b = parse(t[bg], parse(t.bg));
    const f = parse(t[fg], b);
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(5)} ${fg.padEnd(18)} on ${bg.padEnd(14)} ${r.toFixed(2)}:1 (min ${min})${note ? `  ${note}` : ""}`);
  }
}
if (failed) {
  console.error(`\n${failed} pair(s) under the minimum`);
  process.exit(1);
}
console.log("\nall pairs pass");
