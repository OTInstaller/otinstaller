# httpx (community package)

This repository packages [github.com/projectdiscovery/httpx](https://github.com/projectdiscovery/httpx) for the OTInstaller Registry as `osintverse-community/httpx`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/httpx`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

```
ot run osintverse-community/httpx --target …
```

Packaged version: 1.12.0.
