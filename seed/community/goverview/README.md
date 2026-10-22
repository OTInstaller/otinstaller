# goverview (community package)

This repository packages [github.com/j3ssie/goverview](https://github.com/j3ssie/goverview) for the OTInstaller Registry as `osintverse-community/goverview`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/goverview`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Only the `probe` subcommand is wrapped; `screen` needs a Chrome browser and is left out. `--no-output` keeps the tool from writing summary files, so each result is one JSON line on stdout. The last upstream release is from 2021.

```
ot run osintverse-community/goverview --url …
```

Packaged version: 1.0.1.
