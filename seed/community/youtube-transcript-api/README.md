# youtube-transcript-api (community package)

This repository packages [github.com/jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) for the OTInstaller Registry as `osintverse-community/youtube-transcript-api`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/youtube-transcript-api`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

It takes a video ID, not a full URL. YouTube often blocks requests from cloud and data-centre IP addresses; when that happens the tool prints the error text instead of JSON (and still exits 0), so run it from a residential connection or through a proxy.

```
ot run osintverse-community/youtube-transcript-api --video_id …
```

Packaged version: 1.2.4.
