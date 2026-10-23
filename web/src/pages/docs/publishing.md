---
layout: ../../layouts/Docs.astro
title: Publishing
description: How a release, tagged on GitHub or GitLab, uploaded from their CI as a trusted publisher, or uploaded with ot publish, becomes a published package on the registry.
---

Every package has an `otinstaller.yaml` manifest. You release it in one of three ways:

| From | How | When it fits |
| --- | --- | --- |
| GitHub | the OTInstaller GitHub App and a `vX.Y.Z` tag, or the release workflow as a [trusted publisher](#publish-from-ci) | the tool lives in a GitHub repository |
| GitLab | a connected project and a `vX.Y.Z` tag, or the release pipeline as a [trusted publisher](#publish-from-ci) | the tool lives in a GitLab project |
| Directly | `ot publish` from your computer | there is no repository, or you would rather not connect one |

Whichever way a release comes in, the registry checks it the same way ([below](#what-the-registry-does-with-a-release)).

## Write the manifest

The easiest way is the [import wizard](/import) (or `ot import <repository URL>`). It detects whether a GitHub or GitLab repository is a Docker tool, a Python tool or a guide. It then drafts `otinstaller.yaml`, and either opens a pull or merge request with it or keeps the manifest on the registry for you.

To write it by hand, run `ot init`. It writes `otinstaller.yaml`, a README if you have none, and a release workflow for GitHub Actions or GitLab CI. Fill in the inputs, outputs, command and ethics answers, then run `ot validate`.

## Release from GitHub or GitLab

Connect the repository first: on GitHub, install the **OTInstaller** GitHub App on it; on GitLab, connect the project from the import wizard.

**Tools:** run the **otinstaller release** workflow with the version you want to publish.

- **Docker tool:** it builds the image for amd64 and arm64, signs it with your repository's identity, writes the image digest into `otinstaller.yaml` and pushes the tag `vX.Y.Z`.
- **Python tool:** it publishes to PyPI with trusted publishing and pins the wheel hash.

**Guides:** nothing needs building, so release from your own computer:

```
ot release 1.2.0
```

It sets `version`, checks the guide as the registry will, commits, and pushes the commit and the tag `v1.2.0` together. It takes a few seconds and needs no CI run. The workflow `ot init --guide` writes does the same from the Actions tab if you prefer; you can also delete it.

## Publish from CI

The release workflow can publish its release itself, with no GitHub App, GitLab connection or stored token. This is trusted publishing: the workflow runs `ot publish --oidc`, and the CI's OIDC ID token proves which repository and workflow it runs in.

1. **Trust the repository** from a namespace you own, on the [dashboard](/dashboard#tp) or with:

   ```
   ot namespace trust acme-osint github:acme/whois-plus --workflow otinstaller-release.yml
   ot namespace trust acme-osint gitlab:acme/whois-plus
   ```

   - `--workflow` limits it to one workflow file (on GitLab, the CI configuration's path), `--environment` to jobs in one deployment environment, and `--package` to one package.
   - The repository must be public.
   - The first run pins the repository's id and its owner's, so a repository that is deleted and created again under the same name can't publish.
   - `ot namespace trusted acme-osint` lists them; `ot namespace untrust acme-osint <id>` removes one.
2. **Turn on the step.** The release workflow `ot init` writes ends with a step that runs `ot publish --oidc` when the variable `OTINSTALLER_PUBLISH` is `oidc`.
   - On GitHub, set it as a repository variable (Settings → Secrets and variables → Actions → Variables). The job needs `permissions: id-token: write`, which the template has.
   - On GitLab, set it as a CI/CD variable. The job needs `id_tokens: {OTINSTALLER_ID_TOKEN: {aud: otinstaller}}`, which the template has.
3. **Run the workflow** as usual. It builds, signs and tags the release, then uploads it.

What happens next:

- **A short-lived token.** The run trades its ID token for a registry token. It lasts an hour and only publishes that package into that namespace.
  - It acts for the owner who added the trusted publisher. If they leave the namespace, another owner must add it again.
  - Each ID token is exchanged once.
- **The repository owns the release**, as with a tag. The package's name belongs to the repository, links in its pages point to the tag, and its image must be signed by the repository's own workflow.
- **With the App as well**, whichever arrives first wins. The other is recognised as the same release, and `ot publish` follows the App's job.
- **Risky triggers.** Runs triggered by `pull_request_target`, or by merge-request pipelines, publish only through a publisher that requires an environment.
- **No token needed.** In CI, `ot publish` uses `--oidc` by itself when no token is set.

## Publish directly

`ot publish` uploads a release from your computer: the manifest, its README and pages, and the images they show. It needs no repository, GitHub App or GitLab connection.

1. **A namespace.** Publish into a namespace you own or publish to, or create one:

   ```
   ot namespace create acme-osint
   ```

   Any signed-in account can create up to three, including one that signs in with OSINTverse.
   - A name that is a GitHub or GitLab user's needs that account linked to yours (Settings → Accounts).
   - Organisations and groups get their namespace by installing the GitHub App or connecting a GitLab project.
   - A new namespace waits for review with its first release, like any new publisher.
   - One nobody publishes into within 30 days is removed.
2. **The artifact.** Make it public and pin it in the manifest:
   - **Docker:** let the registry host the image (below), or push it to a public registry such as GHCR, Docker Hub or Quay and set `runtime.image` to its digest (`docker.io/acme/tool@sha256:...`). It must include `linux/amd64`.
   - **Python:** publish the wheel to PyPI and set `package_version` and `wheel_sha256`.
3. **Upload.**

   ```
   ot publish --dry-run   # what would be uploaded
   ot publish             # upload, and wait for validation
   ot publish --wait      # wait until it is published, rejected or held for review
   ```

`ot publish` validates the manifest first and uploads nothing if it has problems. Problems found by the registry exit 2; a release a check refuses exits 1. It signs in with your `ot login` token, or `OTINSTALLER_TOKEN` in scripts (a token with the `publish` scope: `ot token create ci --scope publish`). In GitHub Actions and GitLab CI, a [trusted publisher](#publish-from-ci) needs no token. Uploads are limited to 25 MB, 300 files and 20 an hour per namespace.

### Host the image on the registry

`ot publish` can push a Docker image to the registry's own mirror, `mirror.otinstaller.com/<namespace>/<name>`, and pin its digest in `otinstaller.yaml` for you. Choose where it gets the image:

```
ot publish --image acme/tool:dev            # a local image (docker or podman save)
ot publish --image-archive image.tar        # an archive: docker save, or buildx --output type=oci
ot publish --build --platform linux/amd64,linux/arm64   # build the folder's Dockerfile with docker buildx
ot publish --build --sign                   # and sign it with cosign (keyless)
```

- **Permissions.** It signs in with your `ot` token. Only owners and publishers of the namespace can push to its repositories.
- **Size.** Blobs go up in 50 MB pieces, so large layers work.
- **Limits.**
  - An image can be at most 2 GB, with at most 10 GB pushed per namespace a day and 30 image pushes an hour.
  - The image must include `linux/amd64`. On Apple silicon, build with `--platform linux/amd64` (or both).
- **Visibility.** A pushed image is not public until a version that uses it is published. Images no version uses are deleted after a week.
- **Without `ot`.** Plain `docker push` works too, for layers under 100 MB. Run `docker login mirror.otinstaller.com` with your `ot` token as the password, then push to `mirror.otinstaller.com/<namespace>/<name>:<version>` and pin the digest yourself.
- **Copies.** The registry keeps no separate copy of a hosted image. It is the copy: takedowns and legal holds apply to it as to any mirrored image.

**Signing.** A package published directly has no repository CI to sign it, so signing is optional. Unsigned packages are labelled as such, and agents (`ot mcp`) won't install an unsigned Docker image.

To sign, use `ot publish --sign` with an image `ot publish` pushes, or keyless cosign yourself (`cosign sign <image>@<digest>`) before you publish. The first version that is signed pins its signer. Every later version must be signed by the same identity: the same email or account, or the same CI workflow on any branch or tag. A later version without a signature is refused. Only keyless (Sigstore) signatures count.

**Repositories later.** A package published directly can move to a repository: the first tag, or trusted CI upload, from a repository in the namespace claims it. From then on it is released from that repository, and uploads are refused with `manifest_name_taken`.

**Owners are told.** Uploads skip the repository, so each one into a namespace that belongs to a GitHub or GitLab account emails the namespace's owners.

## What the registry does with a release

1. **Validation**, within a minute: the manifest, the files it names, the image or wheel. A tagged commit gets an `otinstaller/publish` status, *Validating*, then either *Valid* or a failure naming the [error code](/docs/errors); `ot publish` prints the same.
2. **Checks**: tools are scanned (signature, vulnerabilities, malware heuristics, embedded secrets, a smoke test with the test input and no network). Guides get [content checks](/docs/guides) instead.
3. **Review**, for a new publisher only: a reviewer looks at your first release, usually within 3 business days. Later releases go live as soon as their checks pass.
4. **Published**: a tagged commit's status turns green, you get an email, and `ot install` works.

Your [dashboard](/dashboard) shows every release, how it came in, and why any failed.

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

- Versions are immutable. A rejected version can be tagged or uploaded again after you fix it; a published one cannot change.
- `@latest` is the highest version that is not a prerelease or yanked.
- `ot sync <ns/name>` checks your repository for missed tags right away; the registry also polls every 6 hours. Packages published directly have nothing to sync.

## Backups

The registry keeps its own copy of every published package, so a mistaken ban or takedown on GitHub or GitLab never breaks installs or loses your code.

- **Images**: after the scan passes, the image is copied with its signatures to `mirror.otinstaller.com/<namespace>/<name>`, with the same digest. An image you pushed there with `ot publish` is already on the mirror and isn't copied again. If `ot` cannot pull an image by digest from its registry (403, 404, "denied"), it pulls the same digest from the mirror and cosign verifies the same signature.
- **Wheels**: the verified wheel is kept by the registry; if PyPI no longer serves it, `ot` uses the copy, with the same SHA-256 check.
- **Your repository**: a git bundle of all branches and tags at every release and every week. The last 4 weekly bundles and every release bundle are kept. A package published directly has no repository to bundle; its image or wheel is still backed up.

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
