# nerva (community package)

This repository packages [github.com/praetorian-inc/nerva](https://github.com/praetorian-inc/nerva) for the OTInstaller Registry as `osintverse-community/nerva`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/nerva`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Nerva's go.mod needs Go 1.27, so the build uses golang:1.27-alpine. The optional `--deep` and `--misconfigs` probes are not enabled.

```
ot run osintverse-community/nerva --target …
```

Packaged version: 1.77.0.
