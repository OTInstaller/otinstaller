# robofinder (community package)

This repository packages [github.com/Spix0r/robofinder](https://github.com/Spix0r/robofinder) for the OTInstaller Registry as `osintverse-community/robofinder`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/robofinder`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/robofinder --url …
```

Packaged version: 0.2.2.
