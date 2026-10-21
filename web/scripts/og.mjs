// Renders public/og.png (1200x630) from an inline SVG. Run once with `npm run og` after changing the design.
// Text is rendered with the fonts installed on the machine that runs it, so the committed PNG is the artifact of record.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const mono = "Geist Mono, Cascadia Mono, Consolas, Menlo, monospace";
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0a0a0a"/>
  <rect x="0.5" y="0.5" width="1199" height="629" fill="none" stroke="#303030"/>
  <g transform="translate(72 64)">
    <rect width="40" height="40" fill="#fafafa"/>
    <circle cx="17" cy="17" r="9" fill="none" stroke="#0a0a0a" stroke-width="3.2"/>
    <path d="M24 24l8 8" stroke="#0a0a0a" stroke-width="3.6" stroke-linecap="round"/>
    <path d="M13.5 13.5l3.5 3.3-3.5 3.3" fill="none" stroke="#0a0a0a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="56" y="29" font-family="${mono}" font-size="26" font-weight="600" fill="#fafafa">OTInstaller</text>
  </g>
  <text x="72" y="152" font-family="${mono}" font-size="15" letter-spacing="2.4" fill="#8c8c8c">FREE PUBLIC REGISTRY OF OSINT TOOLS</text>
  <text x="72" y="248" font-family="${mono}" font-size="66" font-weight="600" fill="#fafafa" letter-spacing="-2">Paste what you have.</text>
  <text x="72" y="328" font-family="${mono}" font-size="66" font-weight="600" fill="#fafafa" letter-spacing="-2">Run the right tool.</text>
  <text x="72" y="392" font-family="${mono}" font-size="24" fill="#b3b3b3">Pinned, signed, scanned and reviewed. Then it runs in a box on your own machine.</text>
  <g transform="translate(72 454)">
    <rect width="820" height="76" fill="#141414" stroke="#303030"/>
    <text x="24" y="48" font-family="${mono}" font-size="26" fill="#60a5fa">$</text>
    <text x="52" y="48" font-family="${mono}" font-size="26" fill="#e5e5e5">ot run osintverse-community/holehe e:ada@example.com</text>
  </g>
  <text x="1128" y="92" text-anchor="end" font-family="${mono}" font-size="20" fill="#8c8c8c">otinstaller.com · by OSINTverse</text>
</svg>`;

await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
await writeFile(fileURLToPath(new URL("./og.svg", import.meta.url)), svg.trim() + "\n");
console.log(`wrote ${out}`);
