# instaloader-profile (community package)

This repository packages [github.com/instaloader/instaloader](https://github.com/instaloader/instaloader) for the OTInstaller Registry as `osintverse-community/instaloader-profile`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/instaloader-profile`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

`instaloader_profile.py` is a short entry script that uses Instaloader's Python API to print a public profile as OTInstaller entities; Instaloader's own CLI only writes files.

```
ot run osintverse-community/instaloader-profile --username …
```

Packaged version: 4.15.4.
