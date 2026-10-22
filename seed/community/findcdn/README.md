# findcdn (community package)

This repository packages [github.com/cisagov/findcdn](https://github.com/cisagov/findcdn) for the OTInstaller Registry as `osintverse-community/findcdn`. The tool is the work of its authors, under the CC0-1.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/findcdn`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Upstream's only tag (v0.1.0) is hundreds of commits behind, so the image installs the last commit on the default branch. The result is a JSON block printed between short status lines; `--all` keeps domains with no CDN in the output. dnspython is pinned to 2.7.0 because the tool still calls the deprecated `dns.resolver.query`.

```
ot run osintverse-community/findcdn --domain …
```

Packaged version: 0.0.0-git.7bbf50e.
