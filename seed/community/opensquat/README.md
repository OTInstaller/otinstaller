# opensquat (community package)

This repository packages [github.com/atenreiro/opensquat](https://github.com/atenreiro/opensquat) for the OTInstaller Registry as `osintverse-community/opensquat`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/opensquat`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

openSquat reads keywords from a file, so the wrapper writes the keyword to /tmp/keywords.txt and passes that file. Only the free Community feed is used; the DNS, port, VirusTotal and premium options are not exposed.

```
ot run osintverse-community/opensquat --keyword …
```

Packaged version: 2.3.0.
