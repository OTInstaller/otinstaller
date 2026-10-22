# pyfunceble (community package)

This repository packages [github.com/funilrys/PyFunceble](https://github.com/funilrys/PyFunceble) for the OTInstaller Registry as `osintverse-community/pyfunceble`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/pyfunceble`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

PyFunceble's flags are switches that flip its configured defaults: `--no-files` turns off the output files it would write, `--colour` turns colour off, and `-a` shows every column (status, source, expiration date).

```
ot run osintverse-community/pyfunceble --domain …
```

Packaged version: 4.3.1.
