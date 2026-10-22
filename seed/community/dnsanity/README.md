# dnsanity (community package)

This repository packages [github.com/nil0x42/dnsanity](https://github.com/nil0x42/dnsanity) for the OTInstaller Registry as `osintverse-community/dnsanity`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/dnsanity`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Each resolver is first checked against the built-in template after the template itself is validated against 8.8.8.8, 1.1.1.1 and 9.9.9.9. Resolvers that pass are printed one per line; the tool exits 3 if the template check against the trusted resolvers fails.

```
ot run osintverse-community/dnsanity --servers …
```

Packaged version: 1.4.2.
