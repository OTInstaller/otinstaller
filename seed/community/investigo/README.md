# investigo (community package)

This repository packages [github.com/tdh8316/Investigo](https://github.com/tdh8316/Investigo) for the OTInstaller Registry as `osintverse-community/investigo`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/investigo`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Investigo's last tagged release (v3.0, 2020) predates a full rewrite, so the wrapper pins a recent commit. It uses the copy of the Sherlock site database bundled at that commit (--database), never downloads one at run time, and writes no result files (--no-output). The --download option is not exposed.

```
ot run osintverse-community/investigo --username …
```

Packaged version: 0.0.0-git.3ed07ed.
