# xcrawl3r (community package)

This repository packages [github.com/hueristiq/xcrawl3r](https://github.com/hueristiq/xcrawl3r) for the OTInstaller Registry as `osintverse-community/xcrawl3r`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/xcrawl3r`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Upstream tags have no `v` prefix (`1.2.0`), so the image builds from the tag's commit. The default depth is 1; `--depth 0` crawls without limit and can run until the timeout. In this release `--silent` has no `-s` short form, despite the help text. On first run the tool writes its config to `$HOME/.config/xcrawl3r/config.yaml` (inside the container's `/tmp`).

```
ot run osintverse-community/xcrawl3r --url …
```

Packaged version: 1.2.0.
