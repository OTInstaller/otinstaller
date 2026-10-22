# crt-sh (community package)

This repository packages [github.com/az7rb/crt.sh](https://github.com/az7rb/crt.sh) for the OTInstaller Registry as `osintverse-community/crt-sh`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/crt-sh`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

It queries crt.sh, SSLMate's certspotter API, crt.name and Shodan's CT log index; none needs a key. Quiet mode (-q) is set because without it the subdomains go to stderr, and the JSON mode writes to a file.

```
ot run osintverse-community/crt-sh --domain …
```

Packaged version: 3.0.4.
