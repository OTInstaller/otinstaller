// The registry website: server-rendered from the registry API on Cloudflare Pages, with small Preact
// islands for search-as-you-type and the signed-in pages.
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import preact from "@astrojs/preact";

const site = process.env.SITE_URL ?? "https://otinstaller.com";
const api = new URL(process.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").origin;

export default defineConfig({
  site,
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [preact()],
  // Sign-in lives in the API, so the site keeps no sessions (and needs no KV namespace).
  session: false,
  // Shiki highlights with inline styles, which the CSP below forbids.
  markdown: { syntaxHighlight: false },
  security: {
    checkOrigin: true,
    // Astro hashes its own scripts and styles; everything else is limited to this site and the API.
    csp: {
      directives: [
        "default-src 'self'",
        `connect-src 'self' ${api}`,
        // Guide images come from the API; README images that were not copied load from the repository host.
        `img-src 'self' data: ${api} https://avatars.githubusercontent.com https://gitlab.com https://secure.gravatar.com https://raw.githubusercontent.com`,
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        `form-action 'self' ${api}`,
      ],
    },
  },
});
