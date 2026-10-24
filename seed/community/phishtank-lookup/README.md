# phishtank-lookup (community package)

This repository packages [github.com/Lookyloo/PyPhishtankLookup](https://github.com/Lookyloo/PyPhishtankLookup) for the OTInstaller Registry as `osintverse-community/phishtank-lookup`. The tool is the work of its authors, under the BSD-3-Clause license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/phishtank-lookup`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Queries CIRCL's public copy of the PhishTank feed, which needs no key. A URL that isn't in the feed prints `null`.

```
ot run osintverse-community/phishtank-lookup --url …
```

Packaged version: 1.6.0.
