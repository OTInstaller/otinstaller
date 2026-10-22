# octosuite (community package)

This repository packages [github.com/bellingcat/octosuite](https://github.com/bellingcat/octosuite) for the OTInstaller Registry as `osintverse-community/octosuite`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/octosuite`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

octosuite needs Python 3.13 or newer, so this wrapper uses a Docker image instead of pipx. It prints an ASCII banner on stdout before the JSON profile, so ot treats the output as text. It uses GitHub's unauthenticated API, which allows 60 requests an hour per IP address.

```
ot run osintverse-community/octosuite --username …
```

Packaged version: 5.1.0.
