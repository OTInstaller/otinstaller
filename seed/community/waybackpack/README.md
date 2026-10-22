# waybackpack (community package)

This repository packages [github.com/jsvine/waybackpack](https://github.com/jsvine/waybackpack) for the OTInstaller Registry as `osintverse-community/waybackpack`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/waybackpack`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

The wrapper runs waybackpack with --list, which prints snapshot URLs instead of downloading every archived copy to disk.

```
ot run osintverse-community/waybackpack --url …
```

Packaged version: 0.6.4.
