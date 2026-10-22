# asnmap (community package)

This repository packages [github.com/projectdiscovery/asnmap](https://github.com/projectdiscovery/asnmap) for the OTInstaller Registry as `osintverse-community/asnmap`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/asnmap`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

asnmap queries ProjectDiscovery's ASN API, which needs a free API key in `PDCP_API_KEY`. Without one it tries to prompt on a terminal, fails inside the container and exits with code 1, which is what the smoke test expects.

```
ot run osintverse-community/asnmap --org …
```

Packaged version: 1.1.1.
