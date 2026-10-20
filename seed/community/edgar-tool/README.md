# edgar-tool (community package)

This repository packages [github.com/bellingcat/edgar](https://github.com/bellingcat/edgar) for the OTInstaller Registry as `osintverse-community/edgar-tool`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/edgar-tool`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/edgar-tool --query …
```

Packaged version: 2.1.2.
