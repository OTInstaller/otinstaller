# urx (community package)

This repository packages [github.com/hahwul/urx](https://github.com/hahwul/urx) for the OTInstaller Registry as `osintverse-community/urx`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/urx`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper uses urx's default keyless providers (wayback, cc, otx) and passes --exclude-robots and --exclude-sitemap so it never contacts the target itself, plus --no-cache because the sandbox keeps nothing between runs.

```
ot run osintverse-community/urx --domain …
```

Packaged version: 0.11.0.
