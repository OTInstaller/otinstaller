# gitcolombo (community package)

This repository packages [github.com/soxoj/gitcolombo](https://github.com/soxoj/gitcolombo) for the OTInstaller Registry as `osintverse-community/gitcolombo`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/gitcolombo`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image includes git because gitcolombo shells out to `git clone` and `git log`. Clones go to /tmp/repos inside the container, the only writable folder. Unauthenticated GitHub lookups are limited to 60 an hour, so very large repositories may resolve fewer GitHub logins. Upstream's API-only `--search <username>` mode is not exposed by this wrapper.

```
ot run osintverse-community/gitcolombo --url …
```

Packaged version: 0.3.0.
