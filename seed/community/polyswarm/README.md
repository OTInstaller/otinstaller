# polyswarm (community package)

This repository packages [github.com/polyswarm/polyswarm-cli](https://github.com/polyswarm/polyswarm-cli) for the OTInstaller Registry as `osintverse-community/polyswarm`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/polyswarm`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Searches PolySwarm for the hash and prints each matching artifact as a JSON line. A hash PolySwarm has never seen exits with code 1. Without `POLYSWARM_API_KEY` the CLI refuses to start and exits with code 2, which is what the registry's smoke test expects.

```
ot run osintverse-community/polyswarm --hash …
```

Packaged version: 4.7.0.
