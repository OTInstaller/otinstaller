# bgpranking (community package)

This repository packages [github.com/D4-project/pybgpranking](https://github.com/D4-project/pybgpranking) for the OTInstaller Registry as `osintverse-community/bgpranking`. The tool is the work of its authors, under the BSD-3-Clause license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/bgpranking`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Queries CIRCL's public BGP Ranking service, which needs no key, for the autonomous system's latest daily rank (IPv4).

```
ot run osintverse-community/bgpranking --asn …
```

Packaged version: 2.0.2.
