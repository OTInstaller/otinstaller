---
layout: ../../layouts/Docs.astro
title: CLI reference
description: Every ot command and its options.
---

Run `ot <command> --help` for all flags; `ot help`, `ot completion <shell>` and `ot --version` are there too. Packages
are written `namespace/name`, optionally with `@version`. Every command takes `--json`: data comes out as JSON and
errors as one line of JSON on stderr; see [Scripts, CI and agents](/docs/automation). Flags in brackets are optional.

## Finding and running tools

| Command | What it does |
| --- | --- |
| `ot search [query] [--input email] [--output domain] [--category x] [--runtime docker\|pipx] [--no-keys] [--kind tool\|guide] [--limit 25]` | Search the registry by words, by the input type a tool takes or the entity type it produces |
| `ot info <ns/name \| otinstaller.yaml>` | Summary, inputs, outputs, keys (with the `ot keys set` command), ethics flags, trust status, and a copy-ready run command using the registry's test input |
| `ot install <ns/name[@version] \| otinstaller.yaml> ... [--native]` | Install one or more tools: pull each image by digest and verify its signature, or build its Python package into a container (`--native` installs it with pipx on the host instead). Every name is checked before anything installs; then it says how to try each tool and which keys to set first |
| `ot run <ns/name> --<input> <value> …` | Run a tool; installs it first if needed (`-y`/`--yes` without asking) |
| `ot run <ns/name> u:johndoe` | Typed inputs fill the tool's input of that type: `u:` username, `d:` domain, `e:` email, `p:` phone, `ip:` IP, `url:` URL |
| `ot run … [-f\|--format json\|table\|csv\|raw] [-o\|--output file]` | Output format (the JSON [result envelope](/docs/results) by default, or `format` in `config.json`) and where to write it; `--max-raw BYTES` leaves `raw` out of large envelopes |
| `ot run … [--out-dir DIR] [--native] [--results-dir DIR] [--case NAME] [--no-save]` | Mount a host folder at `/out` for tools that write files; run a pipx tool on the host; where the run is saved (see [Saved results](#saved-results)). `--live` is accepted and does nothing |
| `ot run --all u:johndoe [--parallel 4] [--dry-run] [-f table\|json\|jsonl] [-y]` | Run every installed tool that takes those inputs; `jsonl` streams one line per tool as it finishes. When none does, as on a fresh machine, it offers to install a bundled playbook's tools for that type first (at a terminal; otherwise the error names the `ot playbook … --yes` command) |
| `ot auto <target> [--type username\|email\|domain\|phone\|ip\|url] [--dry-run] [-f table\|json] [--parallel 4] [--results-dir DIR] [--case NAME]` | Guess the target's type (URL, IP, email, phone, domain, else username) and run every installed tool that takes it, offering a bundled playbook's tools first when none does |
| `ot playbook -l\|--list` · `ot playbook <name> <type>:<value> [-y] [--native] [--dry-run] [-f table\|json] [--parallel 4] [--results-dir DIR] [--case NAME]` | Run a named set of tools against the same inputs (bundled, none needing a key: `domain-recon`, `username-investigation`, `email-investigation`, `phone-investigation`, `ip-investigation`; `--list` shows what each takes; your own go in `./playbooks` or `<ot home>/playbooks`); it asks before installing the tools it needs, and `-y` installs them without asking; runs are saved under the case `playbook-<name>` unless `--case` says otherwise |
| `ot list` | Installed tools |
| `ot outdated` · `ot update <ns/name …> \| --all` | Check for and install newer versions, with the same signature and trust checks as `ot install`. `ot outdated` also warns about installed tools that are deprecated (and what replaces them), possibly broken, yanked, moved, or whose source repository is gone; `ot update` installs a moved package under its new name |
| `ot uninstall <ns/name>` | Remove a tool |
| `ot keys set\|list\|rm <NAME>` | API keys in the OS keychain (`set --from-env VAR`); an environment variable of the same name always wins |
| `ot keys setup [tool...]` | Walks through the keys the named tools (or every installed tool) need: what each is, where to get it, what it costs; opens the sign-up page if you want, and asks for each value with typing hidden. Needs a terminal. `--all` also replaces keys already set |
| `ot doctor` | Check Docker, pipx, Python, cosign, the keychain and the registry; says how to install or start Docker when it is missing, and exits 5 when any check fails |
| `ot pivot <run-id \| saved file> [--registry] [--limit 25]` | Suggest the next runs from what a saved run found, with the `ot run` command for each; runs nothing |
| `ot mcp [--results-dir DIR]` | Serve [MCP](/docs/agents) over stdio for AI agents; `ot mcp install claude\|claude-desktop\|cursor\|vscode\|codex\|gemini [--print]` adds it to a client (`--print` only shows the configuration) |
| `ot mcp policy [reset]` · `ot mcp audit [--since 24h]` · `ot mcp tools` | The rules agents run under, what they did, and what the server offers |
| `ot issues <ns/name> [--all]` | The package's open [community issues](/docs/community) (`--all` adds closed ones) |
| `ot request <repo-url> [--note …] [--vote]` | Ask for an open-source tool to be packaged ([tool requests](/requests)); when someone asked already, `--vote` (or yes at the prompt) votes for theirs. Needs `ot login` |
| `ot report <ns/name> --works\|--broken [--version X.Y.Z]` | Say the installed version (or `--version`) works or is broken for you; `--works` needs `ot login`, and `--broken` joins or opens the version's broken issue when signed in |
| `ot report <ns/name> [--reason malware\|policy\|impersonation\|license\|broken\|other --details …] [--version X.Y.Z]` | Report a package privately to the reviewers (opens the form without `--reason`); `--details` is required except for `broken` |
| `ot feedback [--kind bug\|idea\|question\|other] [--about …] [--email …] "message"` | Send feedback to the team with your `ot` version and OS; reads piped text, or opens the form with no message |
| `ot self-update [--check]` | Update ot itself; the release signature is checked first, and an older release is never installed over a newer one. `ot outdated` says when a newer ot is out |

When a tool times out, or exits non-zero without finding anything, `ot run` asks at a terminal whether to report it
as broken. A yes sends the package, version, exit code, OS and `ot` version, never your inputs or output. It asks at
most once a week per version, and never under `ot mcp`, in CI, without a terminal, with `--json`, or with
`OT_NO_TELEMETRY` set; see [Community](/docs/community#from-the-terminal).

## Saved results

Every run's raw output is saved to `./results/<tool>/<target>/` with a `.meta.json` sidecar (command, timing, exit code,
SHA-256, entities found). `--results-dir` or `OT_RESULTS_DIR` moves it, `--case NAME` groups runs under `cases/NAME/`,
and `--no-save` skips saving. The result envelope still goes to stdout.

| Command | What it does |
| --- | --- |
| `ot runs [--tool …] [--target …] [--case …] [--status complete\|failed\|timeout\|interrupted] [--since 168h] [--limit 20] [--results-dir DIR]` | List saved runs, newest first: by default the last 20 from the past week (`--since 0` and `--limit 0` for all). Reads `./results` (or `OT_RESULTS_DIR`) and `<ot home>/results`, where `ot mcp` saves |
| `ot runs <run-id>` | One saved run: what ran, how it ended, what it found and where it is saved; `--json` prints its `.meta.json` |
| `ot extract <tool \| path> [--case …] [--results-dir DIR]` | Pull emails, domains, IPs, URLs and entities out of saved runs |
| `ot diff <tool> <target> [--case …] [--results-dir DIR]` | What changed between the two most recent runs of a tool against a target |

## Guides and docs

| Command | What it does |
| --- | --- |
| `ot guide search [query] [--input email] [--category x] [--level beginner\|intermediate\|advanced] [--format guide\|reference] [--lang en] [--limit 25]` | Search guides |
| `ot guide read <ns/name[@version]> [page] [--list] [--plain]` | Read a page in the terminal |
| `ot guide open <ns/name[@version]> [page]` | Open it on this site |
| `ot guide get <ns/name[@version]>` | Save an offline copy under `<ot home>/guides`; `ot guide read` uses it when offline |
| `ot guide tools <ns/name[@version]> [-y\|--yes] [--native]` | Install every tool the guide uses, after one confirmation |
| `ot docs <ns/tool> [page] [--list] [--plain]` | Read a tool's own docs |

## Publishing

| Command | What it does |
| --- | --- |
| `ot init [--kind docker\|pipx\|guide \| --guide] [--name …] [--namespace …] [--summary …] [--license MIT] [--category …] [--input …] [--package …] [-y\|--yes] [--force]` | Create `otinstaller.yaml`, a README and a release workflow, asking for anything not given; `--package` is the PyPI name for pipx tools, `-y` takes the defaults, `--force` overwrites existing files |
| `ot validate [path] [--tag vX.Y.Z] [--smoke]` | Check the manifest and pages as the registry will; `--smoke` runs the test input |
| `ot release <version> [path] [--no-push] [--remote origin]` | Release a guide: set the version, check, commit, tag and push, without CI |
| `ot login [--gitlab \| --osintverse] [--print-token] [--scope …]` · `ot logout` · `ot whoami` | Sign in with GitHub, GitLab or OSINTverse (publishing needs GitHub or GitLab); `--print-token` for machines without a keychain, `--scope` to limit the token |
| `ot token create <name> [--scope …] [--expires 90]` · `ot token list` · `ot token revoke <id>` | Registry API tokens with [scopes](/docs/api#signing-in-tokens-and-scopes), for scripts, CI and agents |
| `ot import <repository URL …> [--registry] [--community --wrapper URL] [--draft] [--save FILE] [--file FILE] [--id ID] [-y\|--yes]` · `ot import --list` | The import wizard in the terminal: detect the repository, fill in a draft manifest and finish as a pull or merge request (or keep the manifest on the registry with `--registry`). Several URLs import in bulk; `--draft` stops after saving, `--id` continues it later; `--community` packages someone else's tool as a wrapper (admins only) |
| `ot sync <ns/name> [--log]` | Check the source repository now, or show recent sync events |
| `ot profile [namespace] [--sync] [--set key=value] [--unset key]` | Show a publisher's profile; owners refresh it from GitHub and GitLab, override fields (name, bio, location, website, company, avatar, socials, about, pins, hide) or go back to the host value |
| `ot yank <ns/name@version> [--undo]` | Hide a version from search and `@latest` (still installable by exact version) |
| `ot deprecate <ns/name> --message … [--replacement ns/name] [--undo]` | Mark a package deprecated |
| `ot claim <ns/name> [--to ns]` · `ot claim <ns/name> --verify <id>` | Take over a community wrapper of your own project |
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
| 1 | The tool failed, or something else went wrong (including a command line cobra itself rejects, such as an unknown flag) |
| 2 | Wrong usage, an invalid manifest, a missing sign-in, or the registry refused the request |
| 3 | A required API key is missing |
| 4 | Refused for trust reasons: a removed version, an image not pinned by digest, a signature or wheel hash that does not match, or a self-update that fails verification |
| 5 | Docker (or Podman) or pipx is missing, or an `ot doctor` check failed |
| 124 | The tool timed out |
| 130 | Interrupted (Ctrl-C) |

## Settings

| Variable | Effect |
| --- | --- |
| `OT_API_URL` | Use another registry API (for example a staging one) |
| `OT_SITE_URL` | The website `ot guide open`, `ot report` and `ot feedback` open |
| `OT_HOME` | Where `ot` keeps its state (default `~/.ot`, `%APPDATA%\ot` on Windows) |
| `OT_NO_TELEMETRY` | Any value stops the install ping (one anonymous request per install) and the question after a failed run |
| `OT_OUTPUT=json` | JSON output and JSON errors from every command, as if `--json` were given |
| `OT_NONINTERACTIVE=1` | Never prompt, even at a terminal (`ot` never prompts without one) |
| `OT_NO_UPDATE_CHECK=1` | `ot outdated` doesn't look up the latest `ot` release (it does at most once a day otherwise, and never in CI or under `ot mcp`) |
| `OT_MAX_RAW` | Default for `ot run --max-raw` |
| `OT_CONSENT=off` | Don't stop unattended runs that need consent (see [AI agents](/docs/agents#agents-that-use-a-shell)) |
| `OT_RESULTS_DIR` | Where runs are saved (default `./results`; the older `OTINSTALLER_RESULTS_DIR` still works) |
| `OTINSTALLER_TOKEN` | The registry token, instead of the keychain |
| `<KEY NAME>` | Any API key can come from an environment variable of its name; it wins over the keychain |

`<ot home>/config.json` can also set `api_url`, `site_url`, `telemetry` (`false` to turn it off) and `format` (the
default for `ot run --format`). `ot` reads it and never writes it.
