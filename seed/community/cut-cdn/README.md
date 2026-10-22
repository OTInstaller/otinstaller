# cut-cdn (community package)

This repository packages [github.com/ImAyrix/cut-cdn](https://github.com/ImAyrix/cut-cdn) for the OTInstaller Registry as `osintverse-community/cut-cdn`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/cut-cdn`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Pinned to a commit after the v1.0.31 release that stops a crash when the update check cannot read the latest version. The build bumps github.com/modern-go/reflect2 to v1.0.2, which current Go needs. An address that is in a CDN range prints nothing, so an empty result means the target is behind a CDN.

```
ot run osintverse-community/cut-cdn --target …
```

Packaged version: 0.0.0-git.2105f01.
