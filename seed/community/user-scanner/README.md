# user-scanner (community package)

This repository packages [github.com/kaifcodec/user-scanner](https://github.com/kaifcodec/user-scanner) for the OTInstaller Registry as `osintverse-community/user-scanner`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/user-scanner`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Give either a username or an email, not both. Results are printed as coloured text; the JSON export only writes to a file, so it is not used. The tool checks PyPI for a newer version at start-up and asks whether to update; with no terminal attached the question is skipped and the scan continues.

```
ot run osintverse-community/user-scanner --username …
```

Packaged version: 1.5.2.
