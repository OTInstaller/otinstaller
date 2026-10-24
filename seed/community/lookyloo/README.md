# lookyloo (community package)

This repository packages [github.com/Lookyloo/PyLookyloo](https://github.com/Lookyloo/PyLookyloo) for the OTInstaller Registry as `osintverse-community/lookyloo`. The tool is the work of its authors, under the BSD-3-Clause license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/lookyloo`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Searches the public instance at lookyloo.circl.lu, which needs no key, for captures that loaded anything from the host name; it never asks for a new capture. Open a capture at `https://lookyloo.circl.lu/tree/<capture_uuid>`. When the instance is down the CLI prints a message instead of JSON and still exits 0.

```
ot run osintverse-community/lookyloo --domain …
```

Packaged version: 1.43.0.
