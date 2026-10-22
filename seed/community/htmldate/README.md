# htmldate (community package)

This repository packages [github.com/adbar/htmldate](https://github.com/adbar/htmldate) for the OTInstaller Registry as `osintverse-community/htmldate`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/htmldate`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

It prints one date (YYYY-MM-DD), or nothing when it finds none, and exits non-zero when the page can't be downloaded.

```
ot run osintverse-community/htmldate --url …
```

Packaged version: 1.11.0.
