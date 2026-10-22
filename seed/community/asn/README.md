# asn (community package)

This repository packages [github.com/nitefood/asn](https://github.com/nitefood/asn) for the OTInstaller Registry as `osintverse-community/asn`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/asn`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper runs lookups only (-n: no mtr path trace, which needs raw sockets the sandbox doesn't allow) with compact JSON output (-j). A small launcher writes any token you set with `ot keys set` to $HOME/.asn inside the container, where the script looks for it.

```
ot run osintverse-community/asn --target …
```

Packaged version: 0.83.0.
