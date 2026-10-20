---
layout: ../../layouts/Docs.astro
title: Publishing
description: How a tag on GitHub or GitLab becomes a published package on the registry.
---

You publish by pushing a git tag. There is no upload step: the registry reads your repository.

## 1. Connect the repository

The easiest way is the [import wizard](/import) (or `ot import <repository URL>`). It detects whether the repository is a Docker tool, a Python tool or a guide, drafts `otinstaller.yaml`, and either opens a pull or merge request with it or keeps the manifest on the registry for you.

To do it by hand:

1. Run `ot init` in the repository. It writes `otinstaller.yaml`, a README if you have none, and a release workflow for GitHub Actions or GitLab CI.
2. Fill in the inputs, outputs, command and ethics answers, then run `ot validate`.
3. On GitHub, install the **OTInstaller** GitHub App on the repository. On GitLab, connect the project from the import wizard.

## 2. Release

Run the **otinstaller release** workflow with the version you want to publish. For a Docker tool it builds the image for amd64 and arm64, signs it with your repository's identity, writes the image digest into `otinstaller.yaml` and pushes the tag `vX.Y.Z`. For a Python tool it publishes to PyPI with trusted publishing and pins the wheel hash. For a guide it sets the version and tags.

## 3. What the registry does with the tag

1. **Validation**, within a minute: the manifest, the files it names, the image or wheel. The tagged commit gets an `otinstaller/publish` status, *Validating*, then either *Valid* or a failure naming the [error code](/docs/errors).
2. **Checks**: tools are scanned (signature, vulnerabilities, malware heuristics, embedded secrets, a smoke test with the test input and no network). Guides get [content checks](/docs/guides) instead.
3. **Review**, for a new publisher only: a reviewer looks at your first release, usually within 3 business days. Later releases go live as soon as their checks pass.
4. **Published**: the commit status turns green, you get an email, and `ot install` works.

Your [dashboard](/dashboard) shows every release and why any failed.

## Versions

- Versions are immutable. A rejected version can be tagged again after you fix it; a published one cannot change.
- `@latest` is the highest version that is not a prerelease or yanked.
- `ot sync <ns/name>` checks your repository for missed tags right away; the registry also polls every 6 hours.
