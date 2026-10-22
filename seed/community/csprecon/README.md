# csprecon (community package)

This repository packages [github.com/edoardottt/csprecon](https://github.com/edoardottt/csprecon) for the OTInstaller Registry as `osintverse-community/csprecon`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/csprecon`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Give the URL with its scheme (https://). A site without a Content-Security-Policy header returns no results.

```
ot run osintverse-community/csprecon --url …
```

Packaged version: 0.4.7.
