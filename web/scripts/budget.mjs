// Checks the page-weight budgets from docs/web-redesign-plan.md (section 4.11) against a running site: for each
// page, the compressed size of the document, its stylesheets and its scripts (fonts counted separately).
// `npm run build && npm run preview -- --port 4322`, then `npm run budget` (or `npm run budget -- https://otinstaller.com`).
// Exits 1 when a public page is over budget.
import { gzipSync } from "node:zlib";

const base = (process.argv[2] ?? "http://localhost:4322").replace(/\/$/, "");
const pages = ["/", "/search", "/input/email", "/osintverse-community", "/osintverse-community/holehe", "/guides", "/guides/osintverse-community/email-investigation", "/docs/getting-started", "/publish", "/agents"];
const BUDGET = { page: 90 * 1024, js: 25 * 1024, fonts: 60 * 1024 };

const gz = (buf) => gzipSync(buf).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const abs = (href) => new URL(href, base).toString();

let over = 0;
for (const path of pages) {
  const res = await fetch(base + path, { headers: { Accept: "text/html" } });
  const html = await res.text();
  const docGz = gz(Buffer.from(html));
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.includes("cloudflareinsights"));
  const fonts = [...html.matchAll(/<link[^>]+rel="preload"[^>]+as="font"[^>]+href="([^"]+)"/g), ...html.matchAll(/<link[^>]+href="([^"]+)"[^>]+as="font"/g)].map((m) => m[1]);
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].reduce((n, m) => n + gz(Buffer.from(m[1])), 0);
  const size = async (urls) => {
    let total = 0;
    for (const u of new Set(urls)) {
      const r = await fetch(abs(u));
      total += gz(Buffer.from(await r.arrayBuffer()));
    }
    return total;
  };
  const [css, js, font] = await Promise.all([size(styles), size(scripts), size(fonts)]);
  // The Preact runtime and islands are loaded by Astro's hydration scripts, which import further chunks; count
  // those too by following static imports one level deep.
  let chunks = 0;
  for (const u of new Set(scripts)) {
    const text = await (await fetch(abs(u))).text();
    for (const m of text.matchAll(/from"(\.\/[^"]+)"|import\("(\.\/[^"]+)"\)/g)) {
      const dep = new URL(m[1] ?? m[2], abs(u)).toString();
      chunks += gz(Buffer.from(await (await fetch(dep)).arrayBuffer()));
    }
  }
  const page = docGz + css + inlineCss;
  const jsAll = js + chunks;
  const bad = page > BUDGET.page || jsAll > BUDGET.js || font > BUDGET.fonts;
  if (bad) over++;
  console.log(`${bad ? "OVER" : "ok  "} ${path.padEnd(48)} page ${kb(page).padStart(9)} (doc ${kb(docGz)}, css ${kb(css + inlineCss)})  js ${kb(jsAll).padStart(8)}  fonts ${kb(font)}`);
}
console.log(`\nbudgets: page ≤ ${kb(BUDGET.page)} excluding fonts, js ≤ ${kb(BUDGET.js)}, fonts ≤ ${kb(BUDGET.fonts)} (all gzip)`);
if (over) {
  console.error(`${over} page(s) over budget`);
  process.exit(1);
}
