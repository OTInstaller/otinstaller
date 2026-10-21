---
layout: ../../layouts/Docs.astro
title: Security model
description: What the registry checks before publishing, and what ot does before running a tool.
---

The registry is an index. It never runs tools: images come from ghcr.io or registry.gitlab.com and packages from PyPI, and you run them on your own machine. It keeps backup copies only as a safety net, so a mistaken ban or takedown on GitHub or GitLab never breaks your installs.

## Before a release is published

- **Pinned artifacts.** Docker images are referenced by digest and Python wheels by hash, so a version can never point at different code later.
- **Signatures.** Images are signed by the repository's own CI (cosign keyless with the GitHub or GitLab OIDC identity). A namespace that signed before cannot publish an unsigned version.
- **Scans.** Trivy (vulnerabilities, secrets, misconfigurations), GuardDog for Python packages, an SBOM, and a smoke test with the tool's test input and no network.
- **Review.** A person reviews every new publisher's first release against the acceptable use rules.
- **Guides.** Links are checked, malicious links block the release, and possible personal data in examples goes to a reviewer.

Each tool's **Security** tab shows the results for every version.

## When you run a tool

- `ot` checks the image signature against the identity recorded at publish and refuses a mismatch.
- Containers run read-only, with all capabilities dropped, no new privileges, a non-root user, a process limit, 1 GB of memory and 2 CPUs. No host folders are mounted.
- Input values are passed as separate arguments, never through a shell.
- API keys come from your OS keychain and are passed to that container only.
- Removed versions are refused with the reason.

## Backups

- Every published image is copied, with its signatures and the same digest, to `mirror.otinstaller.com`; every wheel and a bundle of the source repository are kept too.
- If an image's registry refuses it, `ot` pulls the same digest from the mirror and checks the same signature, so a backup can't be swapped for something else. Wheels from the backup are held to the same SHA-256.
- Public mirrors exist only for OSI-approved licenses. When a package is removed for policy or legal reasons, its backups stop being served at once and are deleted within 30 days.
- A restore drill each month restores a random backup and verifies a mirrored image's signature; a failure alerts the team.

## Reporting a problem

Report a tool from its page, or write to [security@otinstaller.com](mailto:security@otinstaller.com) for vulnerabilities in the registry or `ot`.
