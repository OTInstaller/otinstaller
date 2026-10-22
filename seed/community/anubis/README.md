# anubis (community package)

This repository packages [github.com/jonluca/anubis](https://github.com/jonluca/anubis) for the OTInstaller Registry as `osintverse-community/anubis`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/anubis`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Runs with `-S` (silent), which prints only the subdomains, one per line. The PyPI release (1.3.1) is newer than the last GitHub release tag (1.1.3). Optional Shodan and nmap features (`-i`, `-n`) and sending results to AnubisDB (`-d`) are not used.

```
ot run osintverse-community/anubis --domain …
```

Packaged version: 1.3.1.
