# ipdata (community package)

This repository packages [github.com/ipdata/python](https://github.com/ipdata/python) for the OTInstaller Registry as `osintverse-community/ipdata`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ipdata`: the package is transferred to you.

The `Dockerfile` here installs the upstream release from PyPI at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

`ipdata_lookup.sh` writes the `IPDATA_API_KEY` secret to `~/.ipdata` inside the container (the CLI reads its key only from there, and `ipdata init` would spend a lookup checking it) and runs `ipdata lookup`. A key ipdata refuses prints its error as JSON (`{"message": ..., "status": 401}`) and still exits 0.

```
ot run osintverse-community/ipdata --ip …
```

Packaged version: 4.0.9.
