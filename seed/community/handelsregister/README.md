# handelsregister (community package)

This repository packages [github.com/Handelsregister-AI/handelsregister](https://github.com/Handelsregister-AI/handelsregister) for the OTInstaller Registry as `osintverse-community/handelsregister`. The tool is the work of its authors, under the AGPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/handelsregister`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Runs `handelsregister fetch` with JSON output and the CLI's default sections: people, key financial figures, balance sheet, profit and loss account and register publications. Each lookup uses handelsregister.ai credits. Without `HANDELSREGISTER_API_KEY` the CLI exits with code 1, which is what the registry's smoke test expects.

```
ot run osintverse-community/handelsregister --company …
```

Packaged version: 0.9.0.
