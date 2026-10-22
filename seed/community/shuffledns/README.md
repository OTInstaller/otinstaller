# shuffledns (community package)

This repository packages [github.com/projectdiscovery/shuffledns](https://github.com/projectdiscovery/shuffledns) for the OTInstaller Registry as `osintverse-community/shuffledns`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/shuffledns`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image bundles massdns (built from a pinned commit), a resolver list of eight well-known public resolvers (Cloudflare, Google, Quad9, OpenDNS) and the SecLists top-5,000 subdomain wordlist at a pinned commit. Concurrency is lowered to 200 (`-t 200`) to stay polite to the public resolvers.

```
ot run osintverse-community/shuffledns --domain …
```

Packaged version: 1.2.1.
