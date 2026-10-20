# ignorant (community package)

This repository packages [github.com/megadose/ignorant](https://github.com/megadose/ignorant) for the OTInstaller Registry as `osintverse-community/ignorant`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ignorant`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/ignorant --country_code … --phone …
```

Packaged version: 1.2.0.
