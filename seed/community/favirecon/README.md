# favirecon (community package)

This repository packages [github.com/edoardottt/favirecon](https://github.com/edoardottt/favirecon) for the OTInstaller Registry as `osintverse-community/favirecon`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/favirecon`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Only favicons whose hash is in favirecon's built-in database produce a line of output, so an empty result means the favicon was not recognised, not that the run failed.

```
ot run osintverse-community/favirecon --target …
```

Packaged version: 1.0.4.
