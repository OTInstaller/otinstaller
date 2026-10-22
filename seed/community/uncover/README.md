# uncover (community package)

This repository packages [github.com/projectdiscovery/uncover](https://github.com/projectdiscovery/uncover) for the OTInstaller Registry as `osintverse-community/uncover`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/uncover`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The engine defaults to shodan-idb (Shodan InternetDB), which needs no key and takes an IP or CIDR as the query. Pick another engine and set its key to search with that engine's query syntax.

```
ot run osintverse-community/uncover --query …
```

Packaged version: 1.2.1.
