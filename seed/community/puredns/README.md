# puredns (community package)

This repository packages [github.com/d3mondev/puredns](https://github.com/d3mondev/puredns) for the OTInstaller Registry as `osintverse-community/puredns`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/puredns`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image bundles massdns 1.1.0, the SecLists top 5,000 subdomain wordlist (pinned commit) and a short list of large public resolvers (Cloudflare, Google, Quad9, OpenDNS). puredns validates results against 8.8.8.8 and 8.8.4.4. Set rate_limit (for example 500) to throttle queries to the public resolvers.

```
ot run osintverse-community/puredns --domain …
```

Packaged version: 2.1.1.
