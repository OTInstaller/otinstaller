# numint (community package)

This repository packages [github.com/whoamitang/numint](https://github.com/whoamitang/numint) for the OTInstaller Registry as `osintverse-community/numint`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/numint`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

The wrapper runs `--offline --api`, so it never sends the number to an LLM and never probes sign-up pages for registered accounts. With no keys it still returns the offline profile (validity, line type, formats, country, region, carrier and time zones). Upstream has no release, so the wrapper pins a commit. It exits 1 when the number is not a possible number.

```
ot run osintverse-community/numint --phone …
```

Packaged version: 0.0.0-git.9186c35.
