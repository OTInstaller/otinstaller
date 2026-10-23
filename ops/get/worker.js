// get.otinstaller.com: serves the ot install scripts from the latest release, so the documented one-liners
//
//   curl -fsSL https://get.otinstaller.com/ot | sh
//   irm https://get.otinstaller.com/ot.ps1 | iex
//
// always install the newest ot. The scripts carry the release public key (the release workflow fills it in) and
// check every download against it, so this Worker only has to pass them through.
//
//   curl -fsSL https://get.otinstaller.com/otlite | sh
//
// installs otlite. Its script (otlite/scripts/install.sh) installs from PyPI with pipx or uv, so it is served from the
// main branch rather than a release.
//
//   GET https://get.otinstaller.com/ot/latest  ->  {"version": "v0.13.1"}
//
// names the latest ot release, for `ot self-update` and the note `ot outdated` prints when a newer ot is out. It reads
// the tag from GitHub's /releases/latest redirect, which isn't held to the API's limit of 60 requests an hour per
// address, and answers from the cache for an hour. ot still checks every release file against the release key, so a
// wrong answer here can't install anything it shouldn't. Anything else goes to the docs.
const FILES = {
  "/ot": "install.sh",
  "/ot.sh": "install.sh",
  "/install.sh": "install.sh",
  "/ot.ps1": "install.ps1",
  "/install.ps1": "install.ps1",
};
const OTLITE = ["/otlite", "/otlite.sh"];

// A release tag ot accepts from /ot/latest; prereleases are never offered.
const TAG = /^v\d+\.\d+\.\d+$/;

async function latest(env) {
  const repo = env.RELEASE_REPO || "OTInstaller/ot";
  const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: "manual", cf: { cacheTtl: 300, cacheEverything: true } });
  // github.com answers 302 with Location: https://github.com/<repo>/releases/tag/<tag>.
  const location = res.headers.get("location") || "";
  const tag = decodeURIComponent(location.split("/releases/tag/")[1] || "");
  if (!TAG.test(tag)) {
    const message = `could not tell the latest ot release (GitHub answered ${res.status})`;
    return Response.json({ error: { code: "latest_unknown", message } }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ version: tag }, { headers: { "cache-control": "public, max-age=3600" } });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ot/latest") return latest(env);
    const otlite = OTLITE.includes(pathname);
    const file = otlite ? "otlite/scripts/install.sh" : FILES[pathname];
    if (!file) return Response.redirect("https://otinstaller.com/docs/getting-started", 302);
    const url = otlite
      ? `https://raw.githubusercontent.com/${env.OTLITE_REPO || "OTInstaller/otinstaller"}/main/${file}`
      : `https://github.com/${env.RELEASE_REPO || "OTInstaller/ot"}/releases/latest/download/${file}`;
    const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) {
      // Fail loudly in the user's shell instead of piping an HTML error page into sh.
      const docs = otlite ? "https://otinstaller.com/docs/otlite" : "https://otinstaller.com/docs/getting-started";
      const msg = `could not download ${file} (GitHub answered ${res.status}); see ${docs}`;
      const body = file.endsWith(".ps1") ? `throw '${msg}'\n` : `echo 'error: ${msg}' >&2\nexit 1\n`;
      return new Response(body, { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(res.body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  },
};
