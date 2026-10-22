# webpalm (community package)

This repository packages [github.com/XORbit01/webpalm](https://github.com/XORbit01/webpalm) for the OTInstaller Registry as `osintverse-community/webpalm`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/webpalm`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper runs webpalm in its default live mode, which prints the page tree as it crawls. Without -w it fetches one page at a time, so a depth of 2 or more on a large site can take a long while.

```
ot run osintverse-community/webpalm --url …
```

Packaged version: 2.0.20.
