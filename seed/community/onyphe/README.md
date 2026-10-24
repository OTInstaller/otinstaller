# onyphe (community package)

This repository packages [github.com/onyphe/pyonyphe](https://github.com/onyphe/pyonyphe) for the OTInstaller Registry as `osintverse-community/onyphe`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/onyphe`: the package is transferred to you.

The `Dockerfile` here installs the upstream release from PyPI at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image installs the `cli` extra (Typer and Rich), which the command needs and the plain wheel leaves out, so this is a Docker wrapper rather than a pipx one.

Runs `pyonyphe summary ip`, which prints ONYPHE's summary as JSON. Without `ONYPHE_API_KEY` the CLI says so on stderr and exits with code 2, which is what the registry's smoke test expects.

```
ot run osintverse-community/onyphe --ip …
```

Packaged version: 3.1.1.
