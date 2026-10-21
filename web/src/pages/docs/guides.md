---
layout: ../../layouts/Docs.astro
title: Guides and tool docs
description: Publish versioned Markdown guides and a Docs tab for your tool.
---

Guides are investigation playbooks and references, published from a repository like tools and linked to the tools they use. `ot init --guide` scaffolds one.

## The guide manifest

```yaml
schema: 1
kind: guide
name: email-investigation-playbook
namespace: alice
version: 1.0.0
title: Email investigation playbook
summary: A repeatable workflow from one email address to linked accounts and breaches
license: CC-BY-4.0
categories: [email]
level: intermediate        # beginner, intermediate or advanced
format: guide              # guide or reference
language: en
content:
  root: docs/
  nav: [index.md, 01-scope-and-legal.md, 02-passive-checks.md]
related_tools:
  - osintverse-community/holehe
topics: [email]
```

A tool gets a Docs tab (and `ot docs`) with one extra field:

```yaml
docs:
  root: docs/
  nav: [usage.md, output-fields.md]
```

## Content rules

- CommonMark and GitHub-flavoured Markdown, with `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]` admonitions and fenced code. Raw HTML is shown as text; scripts, iframes, forms and styles reject the release.
- Images live in the repository as PNG, JPEG, WebP or SVG: at most 2 MB each and 50 MB per version. The registry copies them and removes their metadata (EXIF, GPS, author fields) first.
- At most 100 pages per version and 200 KB per page.
- `related_tools` must be published tools.
- Examples use fictional data, your own data, or public figures in their public role. A scope and legal note is expected when the techniques touch personal data.

`ot validate` checks all of this locally.

## Checks on every release

- Every external link is fetched once. Dead links and links to pages that are not in the guide are warnings, listed on the guide's security page; links that Cloudflare URL Scanner finds malicious reject the release.
- Email addresses outside example domains, phone numbers and names next to street addresses are flagged for a reviewer before the guide goes public.
- Links are checked again every night. A guide with more than 20% dead links is marked **Needs update** until a new version fixes them.
