# shodan-host (community package)

This repository packages [github.com/achillean/shodan-python](https://github.com/achillean/shodan-python) for the OTInstaller Registry as `osintverse-community/shodan-host`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/shodan-host`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

`shodan_host.sh` passes the `SHODAN_API_KEY` secret to `shodan init` inside the container (the Shodan CLI only reads keys from its config file) and runs `shodan host`.

```
ot run osintverse-community/shodan-host --ip …
```

Packaged version: 1.31.0.
