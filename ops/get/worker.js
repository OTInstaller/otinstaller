// get.otinstaller.com: serves the ot install scripts from the latest release, so the documented one-liners
//
//   curl -fsSL https://get.otinstaller.com/ot | sh
//   irm https://get.otinstaller.com/ot.ps1 | iex
//
// always install the newest ot. The scripts carry the release public key (the release workflow fills it in) and
// check every download against it, so this Worker only has to pass them through. Anything else goes to the docs.
const FILES = {
  "/ot": "install.sh",
  "/ot.sh": "install.sh",
  "/install.sh": "install.sh",
  "/ot.ps1": "install.ps1",
  "/install.ps1": "install.ps1",
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const file = FILES[pathname];
    if (!file) return Response.redirect("https://otinstaller.com/docs/getting-started", 302);
    const repo = env.RELEASE_REPO || "OTInstaller/ot";
    const res = await fetch(`https://github.com/${repo}/releases/latest/download/${file}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) {
      // Fail loudly in the user's shell instead of piping an HTML error page into sh.
      const msg = `could not download ${file} from the latest ot release (GitHub answered ${res.status}); see https://otinstaller.com/docs/getting-started`;
      const body = file.endsWith(".ps1") ? `throw '${msg}'\n` : `echo 'error: ${msg}' >&2\nexit 1\n`;
      return new Response(body, { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(res.body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};
