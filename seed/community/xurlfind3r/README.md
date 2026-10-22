# xurlfind3r (community package)

This repository packages [github.com/hueristiq/xurlfind3r](https://github.com/hueristiq/xurlfind3r) for the OTInstaller Registry as `osintverse-community/xurlfind3r`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/xurlfind3r`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Upstream tags have no `v` prefix (`1.3.0`), so `go install ...@1.3.0` does not resolve; the image builds from the tag's commit instead. On first run the tool writes its config to `$HOME/.config/xurlfind3r/config.yaml` (inside the container's `/tmp`). Keyless sources (Wayback Machine, Common Crawl, OTX, Hudson Rock) run by default; set the optional keys to add GitHub, urlscan.io and VirusTotal. Viper reads them from `XURLFIND3R_KEYS_<SOURCE>` environment variables.

```
ot run osintverse-community/xurlfind3r --domain …
```

Packaged version: 1.3.0.
