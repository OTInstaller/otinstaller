# socialscan (community package)

This repository packages [github.com/iojw/socialscan](https://github.com/iojw/socialscan) for the OTInstaller Registry as `osintverse-community/socialscan`. The tool is the work of its authors, under the MPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/socialscan`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/socialscan --query …
```

Packaged version: 2.0.1.
