# getjs (community package)

This repository packages [github.com/003random/getJS](https://github.com/003random/getJS) for the OTInstaller Registry as `osintverse-community/getjs`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/getjs`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The -complete flag turns relative script paths into full URLs using the page's origin.

```
ot run osintverse-community/getjs --url …
```

Packaged version: 2.0.0.
