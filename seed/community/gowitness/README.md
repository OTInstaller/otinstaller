# gowitness (community package)

This repository packages [github.com/sensepost/gowitness](https://github.com/sensepost/gowitness) for the OTInstaller Registry as `osintverse-community/gowitness`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gowitness`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The result is one JSON line per page with the screenshot embedded as base64 (--write-screenshots), because files written inside the container are discarded. The image uses Alpine's Chromium instead of the browser gowitness would otherwise download, and skips network logs and page HTML to keep the output small.

```
ot run osintverse-community/gowitness --url …
```

Packaged version: 3.2.2.
