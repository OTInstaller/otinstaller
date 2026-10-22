# metabigor (community package)

This repository packages [github.com/j3ssie/metabigor](https://github.com/j3ssie/metabigor) for the OTInstaller Registry as `osintverse-community/metabigor`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/metabigor`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

Wraps the `related` command only. Built from the v2.2.0 tag with `go build`, because the module path has no /v2 suffix and `go install ...@v2.2.0` is refused.

```
ot run osintverse-community/metabigor --domain …
```

Packaged version: 2.2.0.
