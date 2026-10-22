# thescrapper (community package)

This repository packages [github.com/champmq/TheScrapper](https://github.com/champmq/TheScrapper) for the OTInstaller Registry as `osintverse-community/thescrapper`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/thescrapper`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The image runs from the tool's own folder because TheScrapper reads its list of social sites (socials.txt) from the working directory. Only the command-line dependencies are installed, not the Streamlit web UI. --banner suppresses the ASCII banner.

```
ot run osintverse-community/thescrapper --url …
```

Packaged version: 0.0.0-git.de4b51d.
