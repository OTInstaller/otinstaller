# ail-typo-squatting (community package)

This repository packages [github.com/typosquatter/ail-typo-squatting](https://github.com/typosquatter/ail-typo-squatting) for the OTInstaller Registry as `osintverse-community/ail-typo-squatting`. The tool is the work of its authors, under the BSD-2-Clause license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ail-typo-squatting`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper only generates variants (`-a` runs every algorithm, `-o -` prints them, one per line, after a header line). It does not resolve them; network access is used only by tldextract to refresh the public suffix list. The PyPI release (2.7.6) is newer than the latest GitHub release (v2.7.4).

```
ot run osintverse-community/ail-typo-squatting --domain …
```

Packaged version: 2.7.6.
