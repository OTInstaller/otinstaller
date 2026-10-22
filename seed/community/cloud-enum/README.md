# cloud-enum (community package)

This repository packages [github.com/initstring/cloud_enum](https://github.com/initstring/cloud_enum) for the OTInstaller Registry as `osintverse-community/cloud-enum`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/cloud-enum`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper runs with --quickscan, which checks the keyword itself across all three clouds but skips the mutation list and second-level brute-forcing (a full scan can take hours). Pinned to the commit of the 0.9 release; results are printed as text because the tool's JSON format applies only to its log file.

```
ot run osintverse-community/cloud-enum --keyword …
```

Packaged version: 0.9.0.
