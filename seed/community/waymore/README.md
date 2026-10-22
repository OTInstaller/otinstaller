# waymore (community package)

This repository packages [github.com/xnl-h4ck3r/waymore](https://github.com/xnl-h4ck3r/waymore) for the OTInstaller Registry as `osintverse-community/waymore`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/waymore`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Runs in URL mode with --stream, so URLs are printed as they are found (duplicates can appear) and no archived responses are downloaded. URLScan, VirusTotal and Intelligence X keys can only be set in waymore's config.yml, so those sources are skipped here.

```
ot run osintverse-community/waymore --domain …
```

Packaged version: 8.9.0.
