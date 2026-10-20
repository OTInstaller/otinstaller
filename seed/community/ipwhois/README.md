# ipwhois (community package)

This repository packages [github.com/secynic/ipwhois](https://github.com/secynic/ipwhois) for the OTInstaller Registry as `osintverse-community/ipwhois`. The tool is the work of its authors, under the BSD-2-Clause license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ipwhois`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

`ipwhois-rdap` runs `python -m ipwhois.scripts.ipwhois_cli`, because the package's own `ipwhois_cli` console script imports a `main()` the module does not define and always exits 1.

```
ot run osintverse-community/ipwhois --ip …
```

Packaged version: 1.3.0.
