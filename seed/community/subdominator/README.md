# subdominator (community package)

This repository packages [github.com/RevoltSecurities/Subdominator](https://github.com/RevoltSecurities/Subdominator) for the OTInstaller Registry as `osintverse-community/subdominator`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/subdominator`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

It runs only the sources that need no API key; upstream reads keys from a config file, which this wrapper does not set. --no-db stops it saving findings to its local SQLite database, and it needs Python 3.13, so the image uses python:3.13-slim.

```
ot run osintverse-community/subdominator --domain …
```

Packaged version: 3.0.3.
