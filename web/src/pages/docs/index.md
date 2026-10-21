---
layout: ../../layouts/Docs.astro
title: Documentation
description: How to find, install and run OSINT tools with ot, and how to publish your own tools and guides.
---

The OTInstaller Registry is a free index of OSINT tools and investigation guides. Tools stay on GitHub or GitLab, their images on ghcr.io or registry.gitlab.com and their packages on PyPI. The registry checks every release, signs nothing on your behalf and runs nothing for you: the `ot` command installs tools and runs them on your own machine, inside a locked-down container by default.

## Using tools

- [Getting started](/docs/getting-started): install `ot` and run your first tool.
- [CLI reference](/docs/cli): every `ot` command.
- [Scripts, CI and agents](/docs/automation): JSON output, JSON errors and exit codes for scripts and AI agents.
- [Results and the envelope](/docs/results): the result envelope and saved runs.
- [Security model](/docs/security): what the registry checks and what `ot` does before running anything.

## Publishing

- [Publishing](/docs/publishing): from a repository to a published package.
- [Manifest reference](/docs/manifest): every field of `otinstaller.yaml`.
- [Guides and tool docs](/docs/guides): versioned Markdown guides and a Docs tab for your tool.
- [Error codes](/docs/errors): what each validation error means and how to fix it.

Questions not covered here are in the [FAQ](/docs/faq).

Every docs page is also available as Markdown (add `.md` to its URL), and [llms.txt](/llms.txt) lists them for AI agents.
