# gitxray (community package)

This repository packages [github.com/kulkansecurity/gitxray](https://github.com/kulkansecurity/gitxray) for the OTInstaller Registry as `osintverse-community/gitxray`. The tool is the work of its authors, under the AGPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gitxray`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Text output is used because gitxray also prints a banner and status lines to stdout, which would break JSON. Set GH_ACCESS_TOKEN: without it gitxray waits out GitHub's rate limit and big repositories can hit the one-hour timeout.

```
ot run osintverse-community/gitxray --repository …
```

Packaged version: 1.0.20.
