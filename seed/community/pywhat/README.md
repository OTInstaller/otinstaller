# pywhat (community package)

This repository packages [github.com/bee-san/pyWhat](https://github.com/bee-san/pyWhat) for the OTInstaller Registry as `osintverse-community/pywhat`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/pywhat`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper passes --only-text so the input is always treated as text, never as a file or folder path, and works fully offline.

```
ot run osintverse-community/pywhat --text …
```

Packaged version: 5.1.0.
