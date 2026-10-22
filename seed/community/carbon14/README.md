# carbon14 (community package)

This repository packages [github.com/Lazza/Carbon14](https://github.com/Lazza/Carbon14) for the OTInstaller Registry as `osintverse-community/carbon14`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/carbon14`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The report is Pandoc-flavoured Markdown on stdout: general information, the page's HTTP headers, then internal, external and all images sorted by date. Progress messages go to stderr. Dates in the second column use the container's time zone (UTC).

```
ot run osintverse-community/carbon14 --url …
```

Packaged version: 1.0.0.
