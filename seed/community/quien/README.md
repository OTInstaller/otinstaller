# quien (community package)

This repository packages [github.com/retlehs/quien](https://github.com/retlehs/quien) for the OTInstaller Registry as `osintverse-community/quien`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/quien`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper runs `quien all`, which combines every lookup into one JSON document. The interactive TUI that `quien <domain>` opens in a terminal is not used.

```
ot run osintverse-community/quien --domain …
```

Packaged version: 0.12.0.
