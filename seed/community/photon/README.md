# photon (community package)

This repository packages [github.com/s0md3v/Photon](https://github.com/s0md3v/Photon) for the OTInstaller Registry as `osintverse-community/photon`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/photon`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Photon saves every result set to a folder and prints only the one chosen with --stdout, after its progress lines; the wrapper writes the folder to /tmp and prints the set you pick (internal URLs by default). Photon has no packaged release since v1.3.0 (2019), so the image pins the latest commit. It runs on Python 3.10 because a regular expression in photon.py is rejected by Python 3.11 and later, which silently disables intel and script extraction.

```
ot run osintverse-community/photon --url …
```

Packaged version: 0.0.0-git.c8d2566.
