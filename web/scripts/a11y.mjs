// Runs axe-core over the site's main pages in jsdom and prints the violations. Static checks only (no layout, no
// colour contrast: `npm run contrast` covers the tokens), so it catches missing names, labels, landmarks, heading
// order and ARIA misuse. Point it at the preview server: `npm run build && npm run preview -- --port 4322`, then
// `npm run a11y` (or `npm run a11y -- https://otinstaller.com`). Exits 1 on any serious or critical violation.
import axe from "axe-core";
import { JSDOM, VirtualConsole } from "jsdom";

// jsdom has no canvas; the pages do not need one, so that notice is dropped.
const quiet = new VirtualConsole();
quiet.on("jsdomError", (e) => { if (!/not implemented/i.test(String(e.message ?? e))) console.error(e); });

const base = (process.argv[2] ?? "http://localhost:4322").replace(/\/$/, "");
const pages = ["/", "/search", "/input/email", "/osintverse-community/holehe", "/osintverse-community/holehe/security", "/osintverse-community/holehe/versions", "/osintverse-community", "/guides", "/guides/osintverse-community/email-investigation", "/docs/getting-started", "/publish", "/agents", "/policy/transparency", "/nope"];
const skip = new Set(["color-contrast", "region"]);

let failed = 0;
for (const path of pages) {
  const res = await fetch(base + path, { headers: { Accept: "text/html" } });
  const html = await res.text();
  const dom = new JSDOM(html, { url: base + path, pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: quiet });
  const { window } = dom;
  // Run axe inside the jsdom window, as it would run in a browser.
  window.eval(axe.source);
  const results = await window.axe.run(window.document, { rules: Object.fromEntries([...skip].map((r) => [r, { enabled: false }])) });
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  failed += bad.length;
  console.log(`${res.status} ${path}: ${results.violations.length} violation(s), ${bad.length} serious or critical`);
  for (const v of results.violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) console.log(`     ${n.target.join(" ")}`);
  }
  window.close();
}
if (failed) {
  console.error(`\n${failed} serious or critical violation(s)`);
  process.exit(1);
}
console.log("\nno serious or critical violations");
