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

**Tools:** run the **otinstaller release** workflow with the version you want to publish. For a Docker tool it builds the image for amd64 and arm64, signs it with your repository's identity, writes the image digest into `otinstaller.yaml` and pushes the tag `vX.Y.Z`. For a Python tool it publishes to PyPI with trusted publishing and pins the wheel hash.

**Guides:** nothing needs building, so release from your own computer:

```
ot release 1.2.0
```

It sets `version`, checks the guide as the registry will, commits, and pushes the commit and the tag `v1.2.0` together, in a few seconds and without a CI run. The workflow `ot init --guide` writes does the same from the Actions tab if you prefer; you can also delete it.

## 3. What the registry does with the tag

1. **Validation**, within a minute: the manifest, the files it names, the image or wheel. The tagged commit gets an `otinstaller/publish` status, *Validating*, then either *Valid* or a failure naming the [error code](/docs/errors).
2. **Checks**: tools are scanned (signature, vulnerabilities, malware heuristics, embedded secrets, a smoke test with the test input and no network). Guides get [content checks](/docs/guides) instead.
3. **Review**, for a new publisher only: a reviewer looks at your first release, usually within 3 business days. Later releases go live as soon as their checks pass.
4. **Published**: the commit status turns green, you get an email, and `ot install` works.

Your [dashboard](/dashboard) shows every release and why any failed.

## Your publisher profile

Every namespace has a public profile at `otinstaller.com/<namespace>`, like a GitHub or GitLab profile: your name,
avatar, bio, links, the accounts you publish from, your numbers, pinned packages and recent releases.

- **It fills itself in.** The registry copies the public details of the GitHub user or organization, or the GitLab
  user or group, your namespace belongs to, when the namespace is created and every 6 hours after that. Org members
  who made their membership public are listed. Email addresses are never copied.
- **You can change anything.** Open [Dashboard](/dashboard) → **Edit profile**. Each field uses the host value or your
  own; your value wins until you switch back. **Sync now** refreshes from your hosts right away (10 times an hour).
- **Both hosts.** If you publish from GitHub and GitLab, link the other account (or an org or group you own) and the
  profile links to both. Connect the host first under [Accounts and sync](/settings/accounts).
- **About and pins.** Write an About section in Markdown (raw HTML and images are not rendered) and pin up to six
  packages.
- **Privacy.** *Hide profile details* removes the bio, location, website, company, links and people; the name, avatar
  and host links stay. A namespace waiting for its first review shows only its handle and host link.

From the terminal: `ot profile` shows yours, `ot profile --sync` refreshes it, and
`ot profile --set bio="OSINT tools for newsrooms" --set pins=whois-plus,dns-records` edits it. Agents can read
`otinstaller.com/<namespace>.md`.

## Versions

- Versions are immutable. A rejected version can be tagged again after you fix it; a published one cannot change.
- `@latest` is the highest version that is not a prerelease or yanked.
- `ot sync <ns/name>` checks your repository for missed tags right away; the registry also polls every 6 hours.

## Release notes

Tell people what changed and the registry shows it on the package page ("What's new"), under each version on the
Versions tab, and in the API (`GET /v1/tools/<ns>/<name>/versions`). It reads the notes when it validates the tag:

1. **A release for the tag** on GitHub or GitLab: its notes, as written. A release you create or edit later replaces
   them.
2. **Otherwise, `CHANGELOG.md`** (or `CHANGES.md`, `HISTORY.md`) at the tagged commit: the section under the heading
   that names the version, such as `## [1.2.0] - 2026-10-01`, `## v1.2.0` or `### 1.2.0 (2026-10-01)`, up to the next
   heading of the same level. The [Keep a Changelog](https://keepachangelog.com) format works as it is.

Notes are Markdown. Raw HTML is shown as text, images are replaced by their alt text, and relative links point at
your repository at the tagged commit. Notes longer than 20,000 characters are cut.

## Backups

The registry keeps its own copy of every published package, so a mistaken ban or takedown on GitHub or GitLab never breaks installs or loses your code.

- **Images**: after the scan passes, the image is copied with its signatures to `mirror.otinstaller.com/<namespace>/<name>`, with the same digest. If `ot` cannot pull an image by digest from its registry (403, 404, "denied"), it pulls the same digest from the mirror and cosign verifies the same signature.
- **Wheels**: the verified wheel is kept by the registry; if PyPI no longer serves it, `ot` uses the copy, with the same SHA-256 check.
- **Your repository**: a git bundle of all branches and tags at every release and every week. The last 4 weekly bundles and every release bundle are kept.

The rules: only public repositories of published packages are backed up. Bundles over 500 MB and images over 2 GB are skipped (you get an email; the rest is still backed up). Mirrors are public only for OSI-approved licenses; other packages are kept privately, for your restores. When a package is removed for policy or legal reasons, including DMCA requests, its backups are deleted 14 days later unless a legal hold applies. You can turn off git backups from the dashboard; images and wheels stay mirrored because installs depend on them.

### Moving to the other host

If your repository is gone (or you want to leave a host), open the [dashboard](/dashboard), and under **Backups**:

1. **Restore from backup** gives you a download link for the latest bundle (valid for an hour) and the commands:

   ```bash
   git bundle verify tool-2026-10-20.bundle
   git clone --mirror tool-2026-10-20.bundle tool.git
   cd tool.git && git remote set-url origin https://gitlab.com/you/tool.git
   git push --mirror
   ```

2. **Switch source** to the new repository. You need to own the package and be an admin (GitHub, with the OTInstaller app installed) or Maintainer (GitLab) of the new, public repository. The package keeps its name, versions and installs; new releases come from the new repository and must be signed by its CI. Tags that are already in it are not published again.

The same is available from the API: `POST /v1/packages/<ns>/<name>/backups/restore` and `POST /v1/packages/<ns>/<name>/source {"repo": "https://gitlab.com/you/tool"}`.
