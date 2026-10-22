# radar (community package)

This repository packages [github.com/Elite-Security-Systems/radar](https://github.com/Elite-Security-Systems/radar) for the OTInstaller Registry as `osintverse-community/radar`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/radar`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper passes `-signatures` with the signature file from the pinned release, because the default makes radar download the latest signatures from the upstream main branch at run time.

```
ot run osintverse-community/radar --domain …
```

Packaged version: 0.1.1.
