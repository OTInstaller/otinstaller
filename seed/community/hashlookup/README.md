# hashlookup (community package)

This repository packages [github.com/hashlookup/PyHashlookup](https://github.com/hashlookup/PyHashlookup) for the OTInstaller Registry as `osintverse-community/hashlookup`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/hashlookup`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Queries CIRCL's public hashlookup service, which needs no key. A hash it doesn't know prints `{"message": "Non existing MD5", ...}` and still exits 0.

`ot run --native` on Windows fails: the CLI builds its URLs with the operating system's path separator. Runs in the container are not affected.

```
ot run osintverse-community/hashlookup --hash …
```

Packaged version: 1.2.8.
