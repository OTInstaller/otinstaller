# x-tweet-fetcher (community package)

This repository packages [github.com/ythx-101/x-tweet-fetcher](https://github.com/ythx-101/x-tweet-fetcher) for the OTInstaller Registry as `osintverse-community/x-tweet-fetcher`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/x-tweet-fetcher`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

This wrapper runs the single-tweet mode, which uses the FxTwitter API and needs no setup. Timelines, search and replies need a Nitter instance or a browser driver, so they are not exposed here. The exit code is 1 when the tweet can't be fetched; the JSON then carries `error` and `error_code`.

```
ot run osintverse-community/x-tweet-fetcher --url …
```

Packaged version: 3.1.0.
