# joe-sandbox (community package)

This repository packages [github.com/joesecurity/jbxapi](https://github.com/joesecurity/jbxapi) for the OTInstaller Registry as `osintverse-community/joe-sandbox`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/joe-sandbox`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

Searches earlier analyses (it never submits anything) on Joe Sandbox Cloud Pro. A free Cloud Basic key works too: set `JBX_API_URL` to `https://www.joesandbox.com/api` with `ot keys set JBX_API_URL`, or to your own Joe Sandbox server. Give one of `--hash`, `--url` or `--domain`.

API errors are printed as JSON and the exit code is 100 plus the API's error code. Without `JBX_API_KEY` the API answers error 4 and the CLI exits with code 104, which is what the registry's smoke test expects.

```
ot run osintverse-community/joe-sandbox --hash …
```

Packaged version: 3.25.0.
