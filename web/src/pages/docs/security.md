---
layout: ../../layouts/Docs.astro
title: Security model
description: What the registry checks before publishing, and what ot does before running a tool.
---

The registry is an index. It never runs tools: images come from ghcr.io or registry.gitlab.com and packages from PyPI, and you run them on your own machine. It keeps backup copies only as a safety net, so a mistaken ban or takedown on GitHub or GitLab never breaks your installs.

## Before a release is published

- **Pinned artifacts.** Docker images are referenced by digest and Python wheels by hash, so a version can never point at different code later.
- **Signatures.** Images from a repository are signed by its own CI (cosign keyless with the GitHub or GitLab OIDC identity). A package published directly with `ot publish` has no repository: its first keyless signer is pinned, and every later version must be signed by that same identity. Either way, a package that signed before cannot publish an unsigned version.
- **Releases from CI.** A [trusted publisher](/docs/publishing#publish-from-ci) proves its repository with the CI's OIDC ID token, checked against GitHub's or GitLab's published keys. The registry accepts it only from a public repository a namespace owner named, from a workflow in that repository, and pins the repository's id on first use. The token it gets lasts an hour and can only upload that release. Such a release is held to the same rules as the repository's tag: the same name ownership and the same expected signer.
- **Scans.** Trivy (vulnerabilities, secrets, misconfigurations), GuardDog for Python packages, an SBOM, and a smoke test with the tool's test input and no network.
- **Review.** A person reviews every new publisher's first release against the acceptable use rules.
- **Guides.** Links are checked, malicious links block the release, and possible personal data in examples goes to a reviewer.

Each tool's **Security** tab shows the results for every version.

## When you run a tool

- `ot` checks the image signature against the identity recorded at publish and refuses a mismatch.
- Containers run read-only, with all capabilities dropped, no new privileges, a non-root user, a process limit, 1 GB of memory and 2 CPUs. No host folders are mounted.
- Containers have no network unless the manifest declares `network.egress: true`.
- Input values are passed as separate arguments, never through a shell.
- API keys come from your OS keychain and are passed to that container only.
- Removed versions are refused with the reason.

## What `ot` refuses

`ot` exits with code 4 and says why, instead of installing or running, when:

| Situation | What you see |
| --- | --- |
| The image's signature does not verify against the identity the registry recorded at publish | `signature verification failed for <image>; refusing to install` |
| The manifest's image is not pinned by digest | `image <image> is not pinned by digest` |
| No wheel on PyPI matches the manifest's hash, or the downloaded wheel hashes differently | `no wheel for <package> matches the manifest's sha256` or `downloaded wheel hash … does not match the manifest` |
| The package or version was removed by the registry | `tool_removed` with the public reason |
| An agent asks for an unsigned image, or cosign is missing | a refusal saying agents may only install verified images; install it yourself if you trust it |

A missing API key exits with code 3 instead, naming the key and where to get it.

A network error never makes `ot` fall back to the mirror; only an explicit refusal from the original host does (403, 404, 410, "denied", "manifest unknown"), and the fallback is held to the same digest and signature.

## What the registry stores about you

| When | What is kept | What is not |
| --- | --- | --- |
| Browsing the site or API | Cloudflare's cookieless analytics; the edge cache keys anonymous reads by URL | No IP addresses, no cookies without a sign-in |
| `ot install` (the install ping) | A per-day counter per package version | No IP, user, token or machine identifier; `OT_NO_TELEMETRY=1` turns the ping off |
| The daily update check (at a terminal, at most once a day), `ot outdated` and `ot self-update` download every package's latest version (`GET /v1/latest`) or ask `get.otinstaller.com/ot/latest` which `ot` release is newest | Cloudflare's request logs, as for the install scripts | The same requests for everyone: no token, list of installed tools or machine identifier is sent (`ot outdated` asks about each installed package by name, anonymously); `OT_NO_UPDATE_CHECK=1` turns the daily check off |
| Signing in | Your login and a hashed session or API token; provider tokens encrypted at rest | Your email address is never shown publicly and accounts are never linked by email |
| Publishing | The manifest, scan results, backups of public artifacts, and an audit log of staff actions | Private repositories are never read |
| Reporting a tool | The report text and your reporter identity if signed in | Anonymous reports are allowed and rate-limited by IP, which is not stored |

The [privacy policy](/policy/privacy) is the full statement.

## Backups

- Every published image is copied, with its signatures and the same digest, to `mirror.otinstaller.com`; every wheel and a bundle of the source repository are kept too. An image a publisher pushed to the mirror with `ot publish` lives there already. Only the namespace's owners and publishers can push to its repositories, and no one else can pull it until a version that uses it is published.
- If an image's registry refuses it, `ot` pulls the same digest from the mirror and checks the same signature, so a backup can't be swapped for something else. Wheels from the backup are held to the same SHA-256.
- Public mirrors exist only for OSI-approved licenses. When a package is removed for policy or legal reasons, its backups stop being served at once and are deleted 14 days later, unless a legal hold applies.
- A restore drill each month restores a random backup and verifies a mirrored image's signature; a failure alerts the team.

## Reporting a problem

Report a tool from its page, or write to [security@otinstaller.com](mailto:security@otinstaller.com) for vulnerabilities in the registry or `ot`.
