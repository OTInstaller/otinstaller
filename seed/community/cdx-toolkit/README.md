# cdx-toolkit (community package)

This repository packages [github.com/commoncrawl/cdx_toolkit](https://github.com/commoncrawl/cdx_toolkit) for the OTInstaller Registry as `osintverse-community/cdx-toolkit`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/cdx-toolkit`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Searches Common Crawl's URL index, which needs no key, for pages on the domain itself (not its subdomains) in the latest crawl, or the latest `--crawls`. The index is often overloaded: cdx_toolkit retries its 502 and 504 answers, and searching many crawls at once can take minutes.

```
ot run osintverse-community/cdx-toolkit --domain …
```

Packaged version: 0.9.39.
