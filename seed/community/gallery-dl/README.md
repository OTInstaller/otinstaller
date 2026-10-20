# gallery-dl (community package)

This repository packages [github.com/mikf/gallery-dl](https://github.com/mikf/gallery-dl) for the OTInstaller Registry as `osintverse-community/gallery-dl`. The tool is the work of its authors, under the GPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gallery-dl`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/gallery-dl --url …
```

Packaged version: 1.32.17.
