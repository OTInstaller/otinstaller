# favicorn (community package)

This repository packages [github.com/sharsil/favicorn](https://github.com/sharsil/favicorn) for the OTInstaller Registry as `osintverse-community/favicorn`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/favicorn`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper passes --no-fetch, so it prints the favicon hashes and a search link per platform but does not scrape result previews: the ZoomEye preview uses an unofficial web endpoint that often fails and can crash the run. --no-logo skips the terminal animation.

```
ot run osintverse-community/favicorn --domain …
```

Packaged version: 0.1.1.
