# alterx (community package)

This repository packages [github.com/projectdiscovery/alterx](https://github.com/projectdiscovery/alterx) for the OTInstaller Registry as `osintverse-community/alterx`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/alterx`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The update check is turned off (`-duc`) and the tool runs with no network. The output is a candidate list, not confirmed subdomains.

```
ot run osintverse-community/alterx --domain …
```

Packaged version: 0.1.0.
