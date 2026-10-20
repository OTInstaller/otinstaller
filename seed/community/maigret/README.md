# maigret (community package)

This repository packages [github.com/soxoj/maigret](https://github.com/soxoj/maigret) for the OTInstaller Registry as `osintverse-community/maigret`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/maigret`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/maigret --username …
```

Packaged version: 0.6.6.
