---
name: write-osint-guide
description: Write and release an OSINT investigation guide (a method, checklist or reference) for the OTInstaller Registry, with its manifest, pages and the tools it uses. Use when the user wants to write, publish or update an OTInstaller guide, or turn their notes into one.
license: Apache-2.0
---

# Writing an OTInstaller guide

A guide is a repository with `otinstaller.yaml` (`kind: guide`) and Markdown pages under `docs/`. The registry
renders it, checks every link and screens it for personal data. Read https://otinstaller.com/docs/guides.md first.

1. **Start it** with `ot init --guide` (add `--yes` and flags without a terminal). The manifest needs:
   - `title`, `level` (beginner, intermediate or advanced) and `format` (guide or reference)
   - `content.root: docs/` and `content.nav`, the page order
   - `topics`: the input types it is about, such as email or domain
   - `related_tools`: published tools as `namespace/name`, which `ot guide tools` installs
   - a license; CC-BY-4.0 is usual
2. **Write the pages:**
   - plain Markdown with no raw HTML
   - images under `docs/` in PNG, JPEG, WebP or SVG
   - one topic per page, with steps a reader can follow
3. **Follow the content rules** (https://otinstaller.com/policy/acceptable-use):
   - examples use fictional people, the author's own accounts, or public figures acting publicly
   - no how-tos for anything the policy forbids
   - a short scope and legal note on pages about people
4. **Check it** with `validate_manifest` (MCP) or `ot validate`. Problem codes are at
   https://otinstaller.com/docs/errors#guides-and-docs.
5. **Release it** with `ot release X.Y.Z`. That sets the version, validates, commits, tags and pushes. Guides need no CI
   workflow. Only release when the user explicitly says so: it publishes publicly.
