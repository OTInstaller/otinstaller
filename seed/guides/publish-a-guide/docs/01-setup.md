# Set up the repository

In a new repository on GitHub or GitLab:

```
ot init --guide
```

You get `otinstaller.yaml`, a README, `docs/index.md`, a starter `docs/01-scope-and-legal.md` and a release workflow.

## The manifest

```yaml
schema: 1
kind: guide
name: email-investigation
namespace: your-github-name
version: 1.0.0
title: Email investigation playbook
summary: A repeatable workflow from one email address to linked accounts
license: CC-BY-4.0
categories: [email]
level: intermediate          # beginner, intermediate or advanced
format: guide                # guide (a playbook to follow) or reference
language: en
content:
  root: docs/
  nav:
    - index.md
    - 01-scope-and-legal.md
    - 02-headers.md
related_tools:
  - osintverse-community/email-header-parser
  - osintverse-community/holehe
topics: [email]
```

- `nav` is the page order. Every page in it must exist; pages not in it are not published.
- `related_tools` must be tools already published on the registry. Readers install them all with
  `ot guide tools your-name/your-guide`.
- Choose a license that lets others share the guide; `CC-BY-4.0` is the usual choice.

Next: [content rules](02-content-rules.md).
