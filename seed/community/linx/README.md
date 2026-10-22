# linx (community package)

This repository packages [github.com/riza/linx](https://github.com/riza/linx) for the OTInstaller Registry as `osintverse-community/linx`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/linx`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

linx writes its JSON report only to the file named by -output (the format comes from the extension) and logs to stderr. The image links /opt/linx/stdout.json to /dev/stdout so the report lands on stdout. Each result has the URL and about 100 characters of surrounding code.

```
ot run osintverse-community/linx --url …
```

Packaged version: 0.2.0.
