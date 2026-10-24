# safebrowsing (community package)

This repository packages [github.com/Te-k/pysafebrowsing](https://github.com/Te-k/pysafebrowsing) for the OTInstaller Registry as `osintverse-community/safebrowsing`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/safebrowsing`: the package is transferred to you.

The `Dockerfile` here installs the upstream release from PyPI at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

`safebrowsing_url.sh` writes the `SAFEBROWSING_API_KEY` secret into the CLI's config file inside the container (the CLI reads its key only from there) and runs `safebrowsing url --json`. Google allows the free API for non-commercial use only.

```
ot run osintverse-community/safebrowsing --url …
```

Packaged version: 0.1.4.
