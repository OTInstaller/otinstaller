# katana (community package)

This repository packages [github.com/projectdiscovery/katana](https://github.com/projectdiscovery/katana) for the OTInstaller Registry as `osintverse-community/katana`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/katana`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper uses the standard (non-headless) crawler, omits raw requests and response bodies from the JSON lines (-or -ob) to keep output small, and stops crawling after 15 minutes (-ct 15m). Upstream builds katana with CGO enabled, so the image does too.

```
ot run osintverse-community/katana --url …
```

Packaged version: 1.8.0.
