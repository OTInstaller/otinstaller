---
layout: ../../layouts/Docs.astro
title: CLI reference
description: Every ot command and its options.
---

Run `ot <command> --help` for all flags. Packages are written `namespace/name`, optionally with `@version`.

## Finding and running tools

| Command | What it does |
| --- | --- |
| `ot search [query] [--input email] [--category x] [--runtime docker\|pipx] [--no-keys] [--kind tool\|guide]` | Search the registry; `--json` for scripts |
| `ot info <ns/name>` | Summary, inputs, outputs, keys, ethics flags and trust status |
| `ot install <ns/name[@version]> [--native]` | Install a tool (pull its image, or install its Python package) |
| `ot run <ns/name> --<input> <value> …` | Run a tool; installs it first if needed |
| `ot run … --format json\|table\|csv\|raw -o file` | Output format (JSON result envelope by default) and file |
| `ot list` | Installed tools |
| `ot uninstall <ns/name>` | Remove a tool |
| `ot keys set\|list\|rm <NAME>` | API keys in the OS keychain |
| `ot doctor` | Check Docker, pipx, Python and the keychain |
| `ot report <ns/name> [--reason … --details …]` | Report a package to the reviewers (opens the form without `--reason`) |
| `ot self-update [--check]` | Update ot itself; the release signature is checked first |

## Guides and docs

| Command | What it does |
| --- | --- |
| `ot guide search [query] [--input] [--level] [--format] [--lang]` | Search guides |
| `ot guide read <ns/name[@version]> [page] [--list] [--plain]` | Read a page in the terminal |
| `ot guide open <ns/name> [page]` | Open it on this site |
| `ot guide get <ns/name[@version]>` | Save an offline copy; `ot guide read` uses it when offline |
| `ot guide tools <ns/name> [-y]` | Install every tool the guide uses, after one confirmation |
| `ot docs <ns/tool> [page] [--list]` | Read a tool's own docs |

## Publishing

| Command | What it does |
| --- | --- |
| `ot init [--kind docker\|pipx\|guide] [--guide]` | Create `otinstaller.yaml`, a README and a release workflow |
| `ot validate [path] [--tag vX.Y.Z] [--smoke]` | Check the manifest and pages as the registry will; `--smoke` runs the test input |
| `ot release <version> [path] [--no-push]` | Release a guide: set the version, check, commit, tag and push, without CI |
| `ot login [--gitlab \| --osintverse]` · `ot logout` · `ot whoami` | Sign in with GitHub, GitLab or OSINTverse (publishing needs GitHub or GitLab) |
| `ot import <repository URL>` | The import wizard in the terminal |
| `ot sync <ns/name> [--log]` | Check the source repository now, or show recent sync events |
| `ot yank <ns/name@version> [--undo]` | Hide a version from search and `@latest` (still installable by exact version) |
| `ot deprecate <ns/name> --message … [--replacement ns/name] [--undo]` | Mark a package deprecated |
| `ot claim <ns/name> [--to ns]` · `ot claim --verify <id>` | Take over a community wrapper of your own project |
| `ot transfer <ns/name> --to <ns>` · `--accept <id>` · `--decline <id>` | Move a package to another namespace |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The tool failed |
| 2 | Wrong usage, or the registry refused the request |
| 3 | A required API key is missing |
| 4 | Refused for trust reasons (removed version, signature mismatch) |
| 5 | Docker or pipx is missing |
| 124 | The tool timed out |

## Settings

| Variable | Effect |
| --- | --- |
| `OT_API_URL` | Use another registry API (for example a staging one) |
| `OT_SITE_URL` | Where `ot guide open` sends you |
| `OT_HOME` | Where `ot` keeps its state (default `~/.ot`, `%APPDATA%\ot` on Windows) |
| `OT_NO_TELEMETRY=1` | Never send the anonymous install count |
