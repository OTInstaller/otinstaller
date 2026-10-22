# xsubfind3r (community package)

This repository packages [github.com/hueristiq/xsubfind3r](https://github.com/hueristiq/xsubfind3r) for the OTInstaller Registry as `osintverse-community/xsubfind3r`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/xsubfind3r`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Upstream tags have no `v` prefix (`1.1.2`), so `go install ...@1.1.2` does not resolve; the image builds from the tag's commit instead. On first run the tool writes its config to `$HOME/.config/xsubfind3r/config.yaml` (inside the container's `/tmp`). Keyless sources (crt.sh, Certspotter, Anubis, HackerTarget, Wayback Machine, Common Crawl, OTX and others) run by default; the optional keys add more sources. Viper reads them from `XSUBFIND3R_KEYS_<SOURCE>` environment variables; other keyed sources (Censys, Chaos, FullHunt, IntelX, LeakIX, BeVigil, BuiltWith) follow the same pattern.

```
ot run osintverse-community/xsubfind3r --domain …
```

Packaged version: 1.1.2.
