# Release

1. Install the **OTInstaller** GitHub App on the repository (or connect the GitLab project) from the
   [import page](https://otinstaller.com/import).
2. Run the **otinstaller release** workflow with the version, for example `1.0.0`. It sets `version` in the manifest
   and pushes the tag `v1.0.0`.

## Checks on every release

- The pages are rendered and sanitised, and the images copied with their metadata removed.
- Every external link is fetched once. Dead links are warnings on the guide's security page; links Cloudflare URL
  Scanner finds malicious reject the release.
- Possible personal data sends the release to a reviewer.
- A new publisher's first release is reviewed, usually within 3 business days.

After publishing, links are checked again every night. If more than 20% are dead, the guide is marked
**Needs update** until a new version fixes them.

## Reading it

```
ot guide read your-name/your-guide
ot guide read your-name/your-guide 02-headers --plain
ot guide get your-name/your-guide        # offline copy
ot guide tools your-name/your-guide      # install every related tool
```

## Updating

Fix and extend the guide, then release a new version. Readers always get the latest by default, and older versions
stay readable with `@version`.
