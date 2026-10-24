# gleif (community package)

This repository packages [github.com/ggravlingen/pygleif](https://github.com/ggravlingen/pygleif) for the OTInstaller Registry as `osintverse-community/gleif`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gleif`: the package is transferred to you.

The `Dockerfile` here installs the upstream release from PyPI at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image uses Python 3.13, which this release of pygleif requires, so this is a Docker wrapper rather than a pipx one.

Searches GLEIF's free API, which needs no key, by full text and prints its JSON answer: each entity's LEI, legal name, addresses, status and registration details.

```
ot run osintverse-community/gleif --company …
```

Packaged version: 2026.7.3.
