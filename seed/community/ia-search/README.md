# ia-search (community package)

This repository packages [github.com/jjjake/internetarchive](https://github.com/jjjake/internetarchive) for the OTInstaller Registry as `osintverse-community/ia-search`. The tool is the work of its authors, under the AGPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ia-search`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Runs one page of archive.org's advanced search (`--limit` sets its size, 100 by default), which needs no key, and prints each item's identifier, title, date, media type and creator as a JSON line. Open an item at `https://archive.org/details/<identifier>`.

```
ot run osintverse-community/ia-search --query …
```

Packaged version: 5.12.1.
