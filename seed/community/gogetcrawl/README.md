# gogetcrawl (community package)

This repository packages [github.com/karust/gogetcrawl](https://github.com/karust/gogetcrawl) for the OTInstaller Registry as `osintverse-community/gogetcrawl`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gogetcrawl`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The domain is searched as the pattern `*.<domain>/*`, so subdomains are included, and `--collapse` keeps one line per unique URL. Without a limit, large domains can return millions of URLs; set `--limit` for a quick look. Archive errors are silent unless you run the tool with `-v`.

```
ot run osintverse-community/gogetcrawl --domain …
```

Packaged version: 1.1.3.
