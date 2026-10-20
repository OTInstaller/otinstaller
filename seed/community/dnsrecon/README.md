# dnsrecon (community package)

This repository packages [github.com/darkoperator/dnsrecon](https://github.com/darkoperator/dnsrecon) for the OTInstaller Registry as `osintverse-community/dnsrecon`. The tool is the work of its authors, under the GPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/dnsrecon`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

```
ot run osintverse-community/dnsrecon --domain …
```

Packaged version: 1.6.3.
