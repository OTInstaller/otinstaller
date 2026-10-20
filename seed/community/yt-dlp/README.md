# yt-dlp (community package)

This repository packages [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) for the OTInstaller Registry as `osintverse-community/yt-dlp`. The tool is the work of its authors, under the Unlicense license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/yt-dlp`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/yt-dlp --url …
```

Packaged version: 2026.8.19.
