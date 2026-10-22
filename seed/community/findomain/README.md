# findomain (community package)

This repository packages [github.com/Findomain/Findomain](https://github.com/Findomain/Findomain) for the OTInstaller Registry as `osintverse-community/findomain`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/findomain`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Built from the 10.0.1 tag on Debian because Findomain links OpenSSL; the crates.io release is years old. Findomain reads API keys from FINDOMAIN_* environment variables, so the optional keys above add sources when set. Screenshots, port scans, monitoring and the database mode are not used.

```
ot run osintverse-community/findomain --domain …
```

Packaged version: 10.0.1.
