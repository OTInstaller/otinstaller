---
layout: ../../layouts/Docs.astro
title: CLI reference
description: Every ot command and its options.
---

Run `ot <command> --help` for all flags. Packages are written `namespace/name`, optionally with `@version`. Every command
that prints data takes `--json`, and errors then come as one line of JSON on stderr; see
[Scripts, CI and agents](/docs/automation).

## Finding and running tools

| Command | What it does |
| --- | --- |
| `ot search [query] [--input email] [--category x] [--runtime docker\|pipx] [--no-keys] [--kind tool\|guide]` | Search the registry; `--json` for scripts |
| `ot info <ns/name>` | Summary, inputs, outputs, keys, ethics flags and trust status |
| `ot install <ns/name[@version]> [--native]` | Install a tool (pull its image, or install its Python package) |
| `ot run <ns/name> --<input> <value> …` | Run a tool; installs it first if needed (`-y` without asking) |
| `ot run <ns/name> u:johndoe` | Typed inputs fill the tool's input of that type: `u:` username, `d:` domain, `e:` email, `p:` phone, `ip:` IP, `url:` URL |
| `ot run … --format json\|table\|csv\|raw -o file` | Output format (JSON [result envelope](/docs/results) by default) and file; `--max-raw BYTES` leaves `raw` out of large envelopes |
| `ot run --all u:johndoe [--parallel 4] [--dry-run] [-f table\|json\|jsonl]` | Run every installed tool that takes those inputs; `jsonl` streams one line per tool as it finishes |
| `ot auto <target> [--type …] [--dry-run]` | Guess the target's type (URL, IP, email, phone, domain, else username) and run every installed tool that takes it |
| `ot playbook --list` · `ot playbook <name> <type>:<value> [-y]` | Run a named set of tools against the same inputs (bundled: `domain-recon`, `username-investigation`; your own go in `./playbooks` or `<ot home>/playbooks`) |
| `ot list` | Installed tools |
| `ot outdated` · `ot update <ns/name …> \| --all` | Check for and install newer versions, with the same signature and trust checks as `ot install` |
| `ot uninstall <ns/name>` | Remove a tool |
| `ot keys set\|list\|rm <NAME>` | API keys in the OS keychain (`set --from-env VAR`); an environment variable of the same name always wins |
| `ot doctor` | Check Docker, pipx, Python, cosign, the keychain and the registry |
| `ot pivot <run-id \| saved file> [--registry]` | Suggest the next runs from what a saved run found, with the `ot run` command for each; runs nothing |
| `ot mcp` | Serve [MCP](/docs/agents) over stdio for AI agents; `ot mcp install claude\|claude-desktop\|cursor\|vscode\|codex\|gemini` adds it to a client |
| `ot mcp policy` · `ot mcp audit [--since 24h]` · `ot mcp tools` | The rules agents run under, what they did, and what the server offers |
| `ot report <ns/name> [--reason … --details …]` | Report a package to the reviewers (opens the form without `--reason`) |
| `ot feedback [--kind bug\|idea\|question\|other] [--about …] "message"` | Send feedback to the team with your `ot` version and OS; reads piped text, or opens the form with no message |
| `ot self-update [--check]` | Update ot itself; the release signature is checked first |

## Saved results

Every run's raw output is saved to `./results/<tool>/<target>/` with a `.meta.json` sidecar (command, timing, exit code,
SHA-256, entities found). `--results-dir` or `OT_RESULTS_DIR` moves it, `--case NAME` groups runs under `cases/NAME/`,
and `--no-save` skips saving. The result envelope still goes to stdout.

| Command | What it does |
| --- | --- |
| `ot extract <tool \| path> [--case …] [--json]` | Pull emails, domains, IPs, URLs and entities out of saved runs |
| `ot diff <tool> <target> [--json]` | What changed between the two most recent runs of a tool against a target |

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
| `ot login [--gitlab \| --osintverse] [--print-token] [--scope …]` · `ot logout` · `ot whoami` | Sign in with GitHub, GitLab or OSINTverse (publishing needs GitHub or GitLab); `--print-token` for machines without a keychain, `--scope` to limit the token |
| `ot token create <name> [--scope …] [--expires 90]` · `ot token list` · `ot token revoke <id>` | Registry API tokens with [scopes](/docs/api#signing-in-tokens-and-scopes), for scripts, CI and agents |
| `ot import <repository URL>` | The import wizard in the terminal |
| `ot sync <ns/name> [--log]` | Check the source repository now, or show recent sync events |
| `ot yank <ns/name@version> [--undo]` | Hide a version from search and `@latest` (still installable by exact version) |
| `ot deprecate <ns/name> --message … [--replacement ns/name] [--undo]` | Mark a package deprecated |
| `ot claim <ns/name> [--to ns]` · `ot claim --verify <id>` | Take over a community wrapper of your own project |
| `ot transfer <ns/name> --to <ns>` · `--accept <id>` · `--decline <id>` | Move a package to another namespace |

## When a tool's host removes it

The registry keeps its own copy of every published image and Python wheel. If `ot install` can't pull an image by
digest because its registry refuses it (a ban or a deleted repository), it pulls the same digest from
`mirror.otinstaller.com` and checks the same signature with cosign. If PyPI no longer serves a wheel, it downloads the
registry's copy and checks the same SHA-256. You see a note when this happens; nothing else changes. See
[Publishing: Backups](/docs/publishing#backups).

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
| 130 | Interrupted (Ctrl-C) |

## Settings

| Variable | Effect |
| --- | --- |
| `OT_API_URL` | Use another registry API (for example a staging one) |
| `OT_SITE_URL` | Where `ot guide open` sends you |
| `OT_HOME` | Where `ot` keeps its state (default `~/.ot`, `%APPDATA%\ot` on Windows) |
| `OT_NO_TELEMETRY=1` | Never send the anonymous install count |
| `OT_OUTPUT=json` | JSON output and JSON errors from every command, as if `--json` were given |
| `OT_NONINTERACTIVE=1` | Never prompt, even at a terminal (`ot` never prompts without one) |
| `OT_MAX_RAW` | Default for `ot run --max-raw` |
| `OT_CONSENT=off` | Don't stop unattended runs that need consent (see [AI agents](/docs/agents#agents-that-use-a-shell)) |
| `OT_RESULTS_DIR` | Where runs are saved (default `./results`) |
| `OTINSTALLER_TOKEN` | The registry token, instead of the keychain |
