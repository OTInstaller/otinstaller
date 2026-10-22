# ddgr (community package)

This repository packages [github.com/jarun/ddgr](https://github.com/jarun/ddgr) for the OTInstaller Registry as `osintverse-community/ddgr`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/ddgr`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

--json implies --noprompt, so ddgr prints one page of results and exits instead of opening its interactive prompt.

```
ot run osintverse-community/ddgr --query …
```

Packaged version: 2.2.0.
