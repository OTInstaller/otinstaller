# knockpy (community package)

This repository packages [github.com/guelfoweb/knockpy](https://github.com/guelfoweb/knockpy) for the OTInstaller Registry as `osintverse-community/knockpy`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/knockpy`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper runs passive recon (--recon) without the wordlist brute force. VirusTotal and Shodan sources need keys saved with the interactive `knockpy --setup`, which this wrapper can't use, so only the keyless sources run. Each run also saves a report to a SQLite file under /tmp, which is discarded.

```
ot run osintverse-community/knockpy --domain …
```

Packaged version: 9.0.0.
