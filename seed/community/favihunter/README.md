# favihunter (community package)

This repository packages [github.com/eremit4/favihunter](https://github.com/eremit4/favihunter) for the OTInstaller Registry as `osintverse-community/favihunter`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/favihunter`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The VirusTotal mode is not exposed: it stores the API key in the package's own engines.yaml and prompts for one when missing. Output keeps upstream's ANSI colour codes, which favihunter always prints.

```
ot run osintverse-community/favihunter --url …
```

Packaged version: 1.4.0.
