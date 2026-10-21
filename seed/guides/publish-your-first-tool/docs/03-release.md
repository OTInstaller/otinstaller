# Release

## 1. Connect the repository

Install the **OTInstaller** GitHub App on the repository (the [import page](https://otinstaller.com/import) links to
it). That is what lets the registry see your tags. On GitLab, connect the project from the import page instead.

## 2. Run the release workflow

Commit `otinstaller.yaml`, the `Dockerfile` and the workflow, then open the **Actions** tab, choose
**otinstaller release** and run it with the version, for example `0.1.0`.

For a Docker tool it:

1. builds the image for `linux/amd64` and `linux/arm64` and pushes it to GitHub Container Registry,
2. signs it with Sigstore, tied to your repository's workflow (no keys to manage),
3. writes the image digest into `otinstaller.yaml` and commits it,
4. pushes the tag `v0.1.0`.

For a pipx tool it publishes to PyPI with trusted publishing and pins the wheel's SHA-256 instead.

## 3. What happens next

The tag triggers the registry. Your commit gets an `otinstaller/publish` status that moves through:

1. **Validating**: the manifest and the image or wheel.
2. **Checks**: signature, vulnerabilities, malware heuristics, embedded secrets, and the smoke test with `test.input`.
3. **Review**: only for a new publisher's first release, usually within 3 business days.
4. **Published**: you get an email, and `ot install your-name/your-tool` works for everyone.

Your [dashboard](https://otinstaller.com/dashboard) shows each release and, if one fails, the
[error code](https://otinstaller.com/docs/errors) and how to fix it.

## Later releases

Run the workflow again with a new version. Versions never change once published; to fix a mistake, release a new
version and, if needed, yank the old one with `ot yank your-name/your-tool@0.1.0`.

> [!TIP]
> Add a Docs tab to your package with a `docs:` section in the manifest. See
> [Publish a guide](https://otinstaller.com/guides/osintverse-community/publish-a-guide), which uses the same Markdown rules.
