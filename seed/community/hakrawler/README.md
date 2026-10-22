# hakrawler (community package)

This repository packages [github.com/hakluke/hakrawler](https://github.com/hakluke/hakrawler) for the OTInstaller Registry as `osintverse-community/hakrawler`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/hakrawler`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

hakrawler reads its URLs from standard input, so the image adds a small hakrawler-url script that pipes the URL in. The last tagged release (2.1, 2022) uses a tag name Go modules can't resolve, so the image pins the latest commit. Crawling stops after 300 seconds (-timeout 300).

```
ot run osintverse-community/hakrawler --url …
```

Packaged version: 0.0.0-git.52a16fe.
