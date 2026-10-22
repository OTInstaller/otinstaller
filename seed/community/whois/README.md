# whois (community package)

This repository packages [github.com/rfc1036/whois](https://github.com/rfc1036/whois) for the OTInstaller Registry as `osintverse-community/whois`. The tool is the work of its authors, under the GPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/whois`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Built from the v5.6.6 tag (commit 1024386). `-H` hides the legal disclaimers some registries add.

```
ot run osintverse-community/whois --query …
```

Packaged version: 5.6.6.
