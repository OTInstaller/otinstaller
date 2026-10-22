# social-analyzer (community package)

This repository packages [github.com/qeeqbox/social-analyzer](https://github.com/qeeqbox/social-analyzer) for the OTInstaller Registry as `osintverse-community/social-analyzer`. The tool is the work of its authors, under the AGPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/social-analyzer`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

This wrapper runs the Python CLI from PyPI (0.45, the last PyPI release) in its fast mode and prints one JSON document of detected profiles. The site list ships inside the package, so it is as current as that release. With no --top or --websites it checks every site, which can take many minutes.

```
ot run osintverse-community/social-analyzer --username …
```

Packaged version: 0.45.0.
