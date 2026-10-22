# urlfinder (community package)

This repository packages [github.com/projectdiscovery/urlfinder](https://github.com/projectdiscovery/urlfinder) for the OTInstaller Registry as `osintverse-community/urlfinder`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/urlfinder`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

It stops collecting after 10 minutes by default (upstream's -max-time). Large domains can return hundreds of thousands of URLs.

```
ot run osintverse-community/urlfinder --domain …
```

Packaged version: 0.0.3.
