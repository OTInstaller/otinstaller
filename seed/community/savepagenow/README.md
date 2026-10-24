# savepagenow (community package)

This repository packages [github.com/palewire/savepagenow](https://github.com/palewire/savepagenow) for the OTInstaller Registry as `osintverse-community/savepagenow`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/savepagenow`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Asks the Wayback Machine's Save Page Now to capture the page, anonymously, and prints the capture's address. The Wayback Machine fetches the page from its own servers, and the capture is public. When archive.org declines a new capture because it made one moments ago, `--accept-cache` returns that one instead of failing.

Save Page Now limits anonymous captures per address and answers HTTP 429 beyond that, which the CLI reports with exit code 1. For the same reason, and because each run leaves a public capture, the package has no smoke test.

```
ot run osintverse-community/savepagenow --url …
```

Packaged version: 1.3.1.
