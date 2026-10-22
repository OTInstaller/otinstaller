# marple (community package)

This repository packages [github.com/soxoj/marple](https://github.com/soxoj/marple) for the OTInstaller Registry as `osintverse-community/marple`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/marple`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

marple has no releases, so the wrapper pins a commit. Its requirements.txt installs maigret and Search-Engines-Scraper from their master branches, and its version floors conflict with Search-Engines-Scraper's exact pins, so the image installs Search-Engines-Scraper at a pinned commit plus marple's other dependencies directly. The optional maigret plugin is not included.

```
ot run osintverse-community/marple --username …
```

Packaged version: 0.0.0-git.4c33136.
