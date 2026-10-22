# geointel (community package)

This repository packages [github.com/atiilla/GeoIntel](https://github.com/atiilla/GeoIntel) for the OTInstaller Registry as `osintverse-community/geointel`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/geointel`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Only the command-line mode is wrapped; the `--web` interface is not exposed. Without `GEMINI_API_KEY` the tool exits 1 before downloading anything, which is what the smoke test checks.

```
ot run osintverse-community/geointel --image_url …
```

Packaged version: 0.2.0.
