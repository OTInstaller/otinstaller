// The registry website: a Cloudflare Worker that server-renders from the registry API, with small Preact
// islands for search-as-you-type and the signed-in pages.
import { createHash } from "node:crypto";
import { defineConfig, fontProviders } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import preact from "@astrojs/preact";
import { THEME_BOOT } from "./src/lib/theme-boot.ts";

const site = process.env.SITE_URL ?? "https://otinstaller.com";
const api = new URL(process.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").origin;
// The theme boot script is inline (it must run before the first paint), so its hash goes in the CSP.
const bootHash = `sha256-${createHash("sha256").update(THEME_BOOT).digest("base64")}`;

export default defineConfig({
  site,
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [preact()],
  // Sign-in lives in the API, so the site keeps no sessions (and needs no KV namespace).
  session: false,
  // Shiki highlights with inline styles, which the CSP below forbids.
  markdown: { syntaxHighlight: false },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  // The nav's "Publish" is the import wizard; people type /publish too.
  redirects: { "/publish": "/import" },
  // One self-hosted font, as on osintverse.com: Geist Mono for everything (the CSP allows fonts from this site only).
  // Latin subset, upright only.
  fonts: [
    {
      provider: fontProviders.local(),
      name: "Geist Mono Variable",
      cssVariable: "--font-geist",
      fallbacks: ["Cascadia Mono", "ui-monospace", "Menlo", "Consolas", "monospace"],
      options: {
        variants: [{ src: ["@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2"], weight: "100 900", style: "normal", display: "swap" }],
      },
    },
  ],
  security: {
    checkOrigin: true,
    // Astro hashes its own scripts and styles; everything else is limited to this site and the API.
    csp: {
      directives: [
        "default-src 'self'",
        // cloudflareinsights is Cloudflare Web Analytics, which the zone injects into every page.
        `connect-src 'self' ${api} https://cloudflareinsights.com`,
        // Guide images come from the API; README images that were not copied load from the repository host.
        `img-src 'self' data: ${api} https://avatars.githubusercontent.com https://gitlab.com https://secure.gravatar.com https://raw.githubusercontent.com`,
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        `form-action 'self' ${api}`,
      ],
      scriptDirective: { hashes: [bootHash], resources: ["'self'", "https://static.cloudflareinsights.com"] },
    },
  },
});
