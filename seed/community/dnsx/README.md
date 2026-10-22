# dnsx (community package)

This repository packages [github.com/projectdiscovery/dnsx](https://github.com/projectdiscovery/dnsx) for the OTInstaller Registry as `osintverse-community/dnsx`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/dnsx`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper asks for the common record types for one host and leaves out -axfr, which would contact the domain's name servers directly.

```
ot run osintverse-community/dnsx --domain …
```

Packaged version: 1.3.1.
