# fofa (community package)

This repository packages [github.com/fofapro/fofa-py](https://github.com/fofapro/fofa-py) for the OTInstaller Registry as `osintverse-community/fofa`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/fofa`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Calls FOFA's host API, which needs a paid FOFA membership; a free account has no API access. Give `--ip` or `--domain`. Without `FOFA_EMAIL` and `FOFA_KEY` the CLI stops with exit code 1, which is what the registry's smoke test expects.

```
ot run osintverse-community/fofa --ip …
```

Packaged version: 2.0.3.
