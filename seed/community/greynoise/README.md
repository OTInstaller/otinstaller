# greynoise (community package)

This repository packages [github.com/GreyNoise-Intelligence/pygreynoise](https://github.com/GreyNoise-Intelligence/pygreynoise) for the OTInstaller Registry as `osintverse-community/greynoise`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/greynoise`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper uses the Community API (`--offering community`), which free GreyNoise accounts can call; Enterprise keys work with it too. Without `GREYNOISE_API_KEY` the CLI prints how to set it and exits with code 255, which is what the registry's smoke test expects.

```
ot run osintverse-community/greynoise --ip …
```

Packaged version: 3.1.0.
