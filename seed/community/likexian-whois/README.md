# likexian-whois (community package)

This repository packages [github.com/likexian/whois](https://github.com/likexian/whois) for the OTInstaller Registry as `osintverse-community/likexian-whois`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/likexian-whois`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The raw record is printed as text. Upstream's -j JSON mode depends on a parser that fails on some registries' formats and on IP or ASN lookups, so it is not used. The tool also asks release.likexian.com once a day whether a newer version exists.

```
ot run osintverse-community/likexian-whois --domain …
```

Packaged version: 1.15.7.
