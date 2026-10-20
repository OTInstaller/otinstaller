<!--
Outreach pull request. Open it from your own fork, with the files from seed/community/<tool>/ adapted for the
upstream repository:
  - namespace: the upstream owner (their GitHub user or org), not osintverse-community
  - drop `homepage` if it would point at the repository itself, and README.md (they have their own)
  - Docker tools: keep the Dockerfile only if the project has none, and add .github/workflows/otinstaller-release.yml
    from `ot init` (or spec/templates/github-docker.yml)
Check it with `ot validate` (and `ot validate --smoke` where Docker or pipx is available) before opening it.
-->

**Title:** Add otinstaller.yaml for the OTInstaller Registry

Follows up on #{{issue}}.

This adds `otinstaller.yaml`, which lets {{tool}} be installed and run with
[`ot`](https://otinstaller.com/docs/cli) from the [OTInstaller Registry](https://otinstaller.com):

```
ot run {{namespace}}/{{tool}} --{{input}} {{test value}}
```

**What's in it**
- `otinstaller.yaml`: inputs, outputs, how to run the tool, ethics flags, and a safe test input for checks.
  {{pipx: It points at the {{version}} wheel on PyPI by version and SHA-256, so nothing new is built.}}
  {{docker: `Dockerfile` builds the tool. `.github/workflows/otinstaller-release.yml` builds a multi-arch image,
  signs it with Sigstore and pins its digest. Run it from the Actions tab when you release.}}
- No changes to the tool's code.

**To publish** (only if you want to)
1. Install the [OTInstaller GitHub App](https://github.com/apps/otinstaller) on this repository.
2. Push a tag `v{{version}}`. The registry validates it, checks the release and publishes `{{namespace}}/{{tool}}`.
   New publishers get a short first review.

For later releases, bump `version` (and `package_version`/`wheel_sha256`, or run the release workflow) and tag.
Reference: https://otinstaller.com/docs/manifest

I checked it with `ot validate`{{ and `ot validate --smoke`}}. Feel free to change anything, especially the ethics
flags and the summary, or to close this if it's not for you.
