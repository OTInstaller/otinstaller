# nexfil (community package)

This repository packages [github.com/thewhiteh4t/nexfil](https://github.com/thewhiteh4t/nexfil) for the OTInstaller Registry as `osintverse-community/nexfil`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/nexfil`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/nexfil --username …
```

Packaged version: 1.0.6.
