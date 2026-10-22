# osgint (community package)

This repository packages [github.com/hippiiee/osgint](https://github.com/hippiiee/osgint) for the OTInstaller Registry as `osintverse-community/osgint`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/osgint`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The script always prints its ASCII banner to stdout before the JSON object, so the output is treated as text; the JSON follows the banner. The pinned commit is the current default branch (script version 1.1.0); the last tagged release, 1.0.3 from 2022, predates the current code. Email-to-username lookup (`-e`) is also available upstream but is not exposed here.

```
ot run osintverse-community/osgint --username …
```

Packaged version: 0.0.0-git.866a08b.
