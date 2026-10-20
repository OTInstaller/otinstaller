# dnstwist (community package)

This repository packages [github.com/elceef/dnstwist](https://github.com/elceef/dnstwist) for the OTInstaller Registry as `osintverse-community/dnstwist`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/dnstwist`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

```
ot run osintverse-community/dnstwist --domain …
```

Packaged version: 20250130.0.0.
