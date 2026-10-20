# unfurl (community package)

This repository packages [github.com/RyanDFIR/unfurl](https://github.com/RyanDFIR/unfurl) for the OTInstaller Registry as `osintverse-community/unfurl`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/unfurl`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/unfurl --url …
```

Packaged version: 20261007.0.0.
