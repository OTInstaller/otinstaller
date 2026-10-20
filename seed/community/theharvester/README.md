# theharvester (community package)

This repository packages [github.com/laramies/theHarvester](https://github.com/laramies/theHarvester) for the OTInstaller Registry as `osintverse-community/theharvester`. The tool is the work of its authors, under the GPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/theharvester`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

```
ot run osintverse-community/theharvester --domain …
```

Packaged version: 4.11.1.
