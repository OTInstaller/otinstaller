# indicator-intelligence (community package)

This repository packages [github.com/OsmanKandemir/indicator-intelligence](https://github.com/OsmanKandemir/indicator-intelligence) for the OTInstaller Registry as `osintverse-community/indicator-intelligence`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/indicator-intelligence`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The tool prints a coloured banner and log lines before its results: one `DOMAIN : <name> IPs : [...]` line per related domain that resolves. It writes temporary working files to /tmp. Its `--json` flag prints a Python list rather than JSON, so the wrapper uses the text output. Python 3.11 is used because the pinned dependencies (cffi 1.15.1, pycares 4.3.0) have no 3.12 wheels.

```
ot run osintverse-community/indicator-intelligence --domain …
```

Packaged version: 1.1.1.
