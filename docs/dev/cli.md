# `ot` CLI reference

Read from the code in `cli/`. Every statement below comes from the
Go code; file paths are relative to `cli/internal/` unless shown otherwise.

Conventions used here:

- "API" paths are relative to the configured API base (`OT_API_URL`, default `https://api.otinstaller.com/v1`). All
  calls go through `api.Client.do` (`api/client.go`), which sends `User-Agent: ot/<Version>`, `Accept:
  application/json`, and `Authorization: Bearer <token>` **whenever a token is loaded** (keychain or
  `OTINSTALLER_TOKEN`), on every request, including the install ping. HTTP timeout 30 s.
- "Sign-in" = whether the command itself refuses without a token (client-side check), or only the registry does
  (server answers 401/403, which `requestError` turns into exit 2 where it is used).
- "Exit codes" lists what the command can return. Every command can also return **1** for an unclassified error
  (network failure, file I/O error, cobra argument/flag errors; see [Exit codes](#3-exit-codes)).
- Before every command except `help` and `uninstall`, the root `PersistentPreRun` calls `warnRemoved`: if anything is
  installed, it reads `cache/removed.json` and, when that is older than 24 h, refreshes it with `GET /removed` (4 s
  timeout; failures fall back to the cached list), then prints a `warning:` line per installed version that was
  removed. This applies to every command row below and is not repeated.

---

## 1. Commands

Registered in `Root()` (`cli/root.go`) in this order: init, validate, search, info, install, run, playbook, auto,
extract, diff, list, outdated, update, uninstall, keys, doctor, login, logout, whoami, import, sync, guide, docs,
report, feedback, claim, transfer, yank, deprecate, self-update, release. 31 top-level commands, plus subcommands
`keys set|list|rm` and `guide search|read|open|get|tools`.

There are **no aliases** (`Aliases` is never set), **no `Hidden: true` commands**, and **no `Deprecated` commands** in
the code. Cobra adds its own built-ins (see [cobra built-ins](#cobra-built-ins)).

Package references (`parseRef`, `cli/packages.go`): `namespace/name[@version]`. An argument is treated as a **local
manifest path** instead when it ends in `.yaml`/`.yml`, starts with `.`, or contains `\`, **and** the path exists (a
directory means `<dir>/otinstaller.yaml`). Anything else without exactly one `/` is a `runner.UsageError` (exit 2).

### 1.1 Packages

#### `ot search [query]`
- File: `cli/packages.go` (`searchCmd`). Args: `cobra.MaximumNArgs(1)`.
- Flags:

  | Flag | Type | Default | Meaning |
  | --- | --- | --- | --- |
  | `--input` | string | `""` | only packages that accept this input type (`input=`) |
  | `--output` | string | `""` | only packages that produce this entity type (`output=`) |
  | `--category` | string | `""` | only this category (`category=`) |
  | `--runtime` | string | `""` | `docker` or `pipx` (`runtime=`) |
  | `--kind` | string | `""` | `tool` or `guide` (`kind=`) |
  | `--no-keys` | bool | false | only packages needing no API keys (`no_keys=1`) |
  | `--limit` | int | 25 | maximum results (`limit=`, sent when > 0) |
  | `--json` | bool | false | print the raw search response as JSON |

- API: `GET /tools?q=&input=&output=&category=&runtime=&kind=&no_keys=1&limit=` (empty values omitted).
- Output: table `PACKAGE VERSION INPUTS SUMMARY` with badges `[possibly broken, deprecated, manifest held by
  registry]`; "No packages found." when empty.
- Sign-in: no. Exit: 0; 1 on any registry error (errors are **not** wrapped with `requestError`, so a 4xx also exits 1).

#### `ot info <namespace/name>`
- File: `cli/packages.go` (`infoCmd`). Args: `ExactArgs(1)`. Also accepts a local manifest path (then no API call and
  no trust line). `@version` is parsed but ignored (always the latest detail).
- Flags: `--json` (bool, false): prints `{"registry": <tool detail or null>, "manifest": <parsed manifest>}`.
- API: `GET /tools/{ns}/{name}`.
- Output: kind, summary, Trust (verified publisher, signed, manifest held by registry, community-packaged, health),
  Deprecated message, License, then Inputs/Outputs/Key/Ethics and a `Run:` example (tools) or Level/Tools (guides).
- Sign-in: no. Exit: 0; 2 for a bad reference; 1 for registry errors (4xx not wrapped) or manifest parse errors.

#### `ot install <namespace/name[@version]>`
- File: `cli/packages.go` (`installCmd`, `install`). Args: `ExactArgs(1)`. Also accepts a local manifest path.
- Flags: `--native` (bool, false): install pipx tools on the host instead of in a container.
- API: `GET /tools/{ns}/{name}/{version|latest}/manifest`; then, after a successful install of a registry package and
  if telemetry is enabled, `POST /installs` `{"tool": ref, "version": v}` (3 s timeout, errors ignored). Local
  manifests: no API calls, no ping, and a `note:` that signatures are not checked.
- Behaviour: warns (`warning:`) when unsigned, scan status `warn`, health `broken`, publisher not verified, or source
  gone; notes `moved_to`. Validates the manifest before installing. Docker: `pull` by digest, mirror fallback on
  refusal, `cosign verify` when the registry returned a signer identity (missing cosign only warns). Pipx: wheel from
  PyPI by `wheel_sha256` (registry wheel copy as fallback), then a sandbox image `ot-local/<ns>-<name>:<version>` or
  native `pipx install` into `<ot home>/pipx`. Records the install in `state.json`.
- Sign-in: no. Exit: 0; **2** when the registry answers 404 ("not found in the registry") or the reference is bad or
  the manifest is a guide (`UsageError`: "use `ot guide get`"); **4** when the error code is `tool_removed`, the
  response status is `removed`, the manifest fails validation, the image is not digest-pinned, cosign verification
  fails, or a wheel hash mismatches; **5** when Docker/Podman (or, for native pipx, pipx) is missing; 1 otherwise
  (other registry errors, pull or build failures).

#### `ot list`
- File: `cli/packages.go` (`listCmd`). Args: `NoArgs`. No flags. No API call (other than the pre-run removal check).
- Output: table `PACKAGE VERSION RUNTIME INSTALLED` (`(native)` suffix for native pipx), or "Nothing installed yet.
  Try `ot search`." on stdout.
- Exit: 0; 1 if `state.json` cannot be read.

#### `ot uninstall <namespace/name>`
- File: `cli/packages.go` (`uninstallCmd`). Args: `ExactArgs(1)` (must match the installed ref exactly, no `@version`).
  No flags. Skips the pre-run removal check.
- Behaviour: `docker|podman rmi <image>` (local image if any) or `pipx uninstall <package>` for native installs; errors
  from these are ignored. Removes the entry from `state.json`.
- Exit: 0; **2** "is not installed"; 1 on state read/write errors.

#### `ot outdated`
- File: `cli/update.go` (`outdatedCmd`). Args: `NoArgs`.
- Flags: `--json` (bool, false).
- API: `GET /tools/{ns}/{name}/latest/manifest` per installed package.
- Output: table `PACKAGE INSTALLED LATEST STATUS`; statuses `up to date`, `update available`, `removed`, `not in
  registry` (404), `error`, with notes (`moved to …`). "Nothing installed yet." goes to **stderr**.
- Exit: 0 always on a completed check (it changes nothing and does not fail on outdated or errored rows); 1 on state
  errors.

#### `ot update [namespace/name ...]`
- File: `cli/update.go` (`updateCmd`). Args: any number.
- Flags: `--all` (bool, false): update every installed package; `--json` (bool, false).
- API: as `outdated`, then the `install` calls (`GET …/manifest`, `POST /installs`) for each package with an update.
  Native installs stay native.
- Exit: 0; **2** when neither names nor `--all` are given, or both are, or a named package is not installed; **1** when
  any update failed, or (with named packages) any named package ends in a status other than `updated` / `up to date`
  (for example `removed` or `not in registry`).

### 1.2 Running

#### `ot run`
- File: `cli/run_cmd.go` (`runCmd`, `parseArgs`, `execute`), `cli/run_all.go` (`runAll`), `cli/run.go`
  (`ensureInstalled`, `loadSecrets`). Cobra `Use: "run <namespace/name> --<input> <value> ..."`,
  `DisableFlagParsing: true`: cobra parses nothing, so `ot run --help` is handled by ot (prints `runHelp`, exit 0).
- Usage (from `runHelp`):
  `ot run <namespace/name[@version]> [<type>:<value> ...] [--<input> <value> ...] [flags]` and
  `ot run --all <type>:<value> [...] [flags]`.

**How `parseArgs` reads arguments** (exactly):

- Any argument not starting with `-` is positional. The first positional is the package (unless `--all`); the rest
  are typed inputs.
- For an argument starting with `-`, **all** leading dashes are stripped (so `-format`, `--format` and `---format` are
  the same) and it is split once at `=`.
- Boolean switches (take no value; a `=value` is accepted and ignored): `h`/`help`, `native`, `y`/`yes`, `all`,
  `no-save`, `dry-run`, `live` (no-op, accepted for otinstaller compatibility).
- Valued flags (value from `=value` or the next argument; "`--x needs a value`" usage error if missing):

  | Flag | Type | Default | Meaning |
  | --- | --- | --- | --- |
  | `-f`, `--format` | string | `json` single run (or `format` from `config.json`); `table` with `--all` | single run: `json`, `table`, `csv` or `raw` (unknown → exit 2 after the run); `--all`: `table` or `json` only |
  | `-o`, `--output` | string | stdout | write the envelope to this file; prints `Wrote N entities to <file>` on stderr |
  | `--out-dir` | string | none | host directory mounted at `/out` (`-v <dir>:/out:rw`) |
  | `--results-dir` | string | `$OT_RESULTS_DIR`, else `$OTINSTALLER_RESULTS_DIR`, else `./results` | where runs are saved (`~` expanded) |
  | `--case` | string | none | save under `<results-dir>/cases/<case>/` |
  | `--parallel` | int | 4 | tools run at once with `--all`; must be a whole number ≥ 1 |

  | Switch | Meaning |
  | --- | --- |
  | `-h`, `--help` | print the run help, exit 0 |
  | `--native` | install/run pipx tools on the host instead of in a container (applies to an install triggered by `run`; the installed record decides how it runs) |
  | `-y`, `--yes` | install without asking if the tool is not installed |
  | `--no-save` | don't save the run (refused with `--all`) |
  | `--all` | run every installed tool that has an input of the given typed-input types; no package argument |
  | `--dry-run` | with `--all`, list what would run (status `would run`); without `--all` → exit 2 |
  | `--live` | accepted and ignored |

- **Any other `--<name> <value>` (or `-<name>`, `--<name>=<value>`) is a tool input** named `<name>`. Consequence:
  a tool input whose name collides with one of the names above (`all`, `case`, `format`, `output`, `native`, `yes`,
  `help`, `parallel`, `live`, or the one-letter `f`, `o`, `y`, `h`, all valid input names under the schema) cannot be
  passed by name.
- **Typed-input prefixes** (`runner.TypedPrefixes`, `runner/args.go`), written `<prefix>:<value>` and split at the
  first `:`:

  | Prefix | Input type |
  | --- | --- |
  | `u:` | username |
  | `d:` | domain |
  | `e:` | email |
  | `p:` | phone |
  | `ip:` | ip |
  | `url:` | url |

  A known prefix with an empty value (`u:`) is a usage error; the same prefix twice is a usage error; a positional
  with no known prefix is "unexpected argument" (in `ot run`; `auto` and `playbook` guess its type instead). Each typed
  input fills the tool's single input of that type; zero or several inputs of the type is a usage error (several:
  "pass the one you mean by name"); setting the same input by name and by type is a usage error. The first typed value
  names the results folder; otherwise the first `--<input>` given in manifest order does.
- Single run flow: `ensureInstalled` (installed version used if no `@version` or it matches; an installed version
  on the removal list, refreshed at most hourly via `GET /removed`, is refused with exit 4; otherwise prompts
  `Install it now? [Y/n]` on stderr unless `-y`, a non-yes answer is exit 2; local manifest paths are always
  reinstalled), resolve inputs and types, load secrets (env var of the same name, then keychain), run, save, print
  the envelope (`Saved <path>` on stderr).
- `--all` flow (`runAll`): needs at least one typed input; refuses `--<input>`, `-o`, `--out-dir` and `--no-save`;
  considers every installed tool; tools with no matching input are left out, tools with an ambiguous input, a missing
  required input or a missing required key are listed as `skipped`. With the table format it prints `Running N
  tools, P at a time...` and `[n/N] <tool> <status>` on stderr, then a `TOOL STATUS ENTITIES SAVED` table (or JSON
  array of `{tool, version, status, exit_code, entities, output_path, meta_path, reason}`). Parallel runs' stderr goes
  only to the saved `.stderr.txt`.
- API: `GET /removed` (if the cache is older than 1 h); install calls when installing; none for the run itself.
- Sign-in: no.
- Exit codes:
  - 0: tool exited 0 (single run) / every row `complete` or `skipped` (`--all`), or help, or `--dry-run`.
  - 1: tool exited non-zero ("`<ref> exited with code N`"); with `--all` any row not `complete`/`skipped`; results
    folder cannot be created; other errors.
  - 2: argument errors (`runner.UsageError`), unknown `-f` format, `--dry-run` without `--all`, no package (prints the
    help and exits 2), `--all` misuse, "no installed tool has a … input", declined install prompt.
  - 3: a required key is missing (`ot keys set <NAME>` hint, plus the key URL).
  - 4: removed version, or any install trust failure.
  - 5: Docker/Podman (or pipx for native installs) missing.
  - 124: the tool ran past `runtime.timeout_seconds` (default 300).
  - 130: Ctrl-C while a run is being saved (`execute` maps the cancelled context to `ExitInterrupted`), and `--all`
    when the context was cancelled. **Not** with `--no-save`: a killed tool then surfaces as exit code -1 and `ot`
    exits 1.

#### `ot auto <target> [...]`
- File: `cli/auto.go`. `DisableFlagParsing: true`; help text `autoHelp`.
- ot's own handling: `--type <t>` / `--type=<t>` (only the double-dash spelling); `--all` is refused (exit 2). Every
  other argument is passed to `parseArgs` with `--all` prepended and type detection on, so every positional is a
  target: prefixed ones are used as given, bare ones are guessed by `runner.DetectType` in this order: `url`
  (`http://`/`https://`), `ip` (netip, no zone), `email`, `phone` (international `+…`, 7-15 digits), `domain` (ends in
  an IANA TLD from the embedded `runner/tlds.txt`), else `username`.
- Flags (documented in `autoHelp`): `--type` (string; `username`, `email`, `domain`, `phone`, `ip`, `url`, or a raw
  prefix `u`/`d`/`e`/`p`/`ip`/`url`; requires exactly one target), `--dry-run`, `-f/--format` (`table` default or
  `json`), `--parallel` (int, 4), `--results-dir`, `--case`, `-h/--help`. Also parsed but undocumented and without
  effect: `-y/--yes`, `--native`, `--live`. `--no-save`, `-o`, `--out-dir` and `--<input>` are refused by `runAll`.
- Prints `<value> is a <type>` per target on stderr (table format), then behaves as `ot run --all` (message prefix
  "auto").
- API: none beyond the pre-run check. Sign-in: no.
- Exit: as `ot run --all` (0, 1, 2, 130). No targets: prints the help, exit 2. Bad `--type`: exit 2.

#### `ot playbook <name> <type>:<value> ...`
- File: `cli/playbook.go`; loading in `playbook/playbook.go`. `DisableFlagParsing: true`; help text `playbookHelp`.
- ot's own handling: `--list` / `-l` (exact spellings) lists playbooks; `--all` is refused (exit 2). Everything else
  goes through `parseArgs` with type detection: the first positional is the playbook name, the rest are targets
  (prefixed or guessed as in `auto`). No name → the list.
- Flags (from `playbookHelp`): `-l/--list`, `--dry-run`, `-f/--format` (`table` default or `json`; also used by
  `--list`), `-y/--yes` (install the playbook's missing tools first), `--native` (for those installs), `--parallel`
  (int, 4), `--results-dir`, `--case` (default the playbook's `case`, which defaults to `playbook-<name>`),
  `-h/--help`. `--live` accepted; `--no-save`, `-o`, `--out-dir`, `--<input>` refused.
- Sources, later winning on a name clash: bundled (`domain-recon`: dnstwist, ctfr; `username-investigation`: sherlock,
  maigret, all `osintverse-community/`), `<ot home>/playbooks/*.yaml|*.yml`, `./playbooks/*.yaml|*.yml`. YAML keys:
  `name` (defaults to the file stem), `description`, `tools` (`ns/name`, no duplicates, namespace required), `case`,
  `requires_target` (ignored). A broken file is an error.
- Missing tools without `-y`: exit 2 listing `ot install …` commands. With `-y`: installs them (`GET …/manifest`,
  `POST /installs`). Prints `Playbook <name>: <tools>` on stderr (table). Tools with no input of the given types are
  listed as `skipped`.
- Sign-in: no. Exit: as `ot run --all`; also 2 for an unknown playbook, a broken playbook file, a bad list format, or
  when none of the playbook's tools can run with the inputs; install errors propagate their own codes (4, 5, 1).

#### `ot extract <tool | path>`
- File: `cli/saved.go` (`extractCmd`); logic in `results/saved.go`. Args: `MaximumNArgs(1)`.
- Flags: `--case` (string): scan runs under `<results-dir>/cases/<case>` (with a tool argument, only that tool's
  folder); `--results-dir` (string, default `$OT_RESULTS_DIR`, else `$OTINSTALLER_RESULTS_DIR`, else `./results`);
  `--json` (bool).
- Argument: an existing file or folder is scanned directly; otherwise it is a tool (`ns/name` or `name`, namespace
  dropped and sanitized) under the results dir.
- Output: sections Emails, Domains, IPs, URLs and `Entities: <type>`; or "No indicators in N saved run(s)."
- No API. Exit: 0; 2 with no argument and no `--case`, or when the folder does not exist; 1 on read errors.

#### `ot diff <tool> <target>`
- File: `cli/saved.go` (`diffCmd`). Args: `ExactArgs(2)`.
- Flags: `--case` (string), `--results-dir` (string, same default), `--json` (bool).
- Compares the two newest saved outputs in `<results-dir>[/cases/<case>]/<tool>/<sanitized target>/`; line order
  ignored; prints `+ entity`, `- entity`, `+ line`, `- line`, or "No changes between these two runs."
- No API. Exit: 0 (also when there are differences); 2 when fewer than two runs are found; 1 on read errors.

#### `ot keys` (`keys set|setup|list|rm`)
- File: `cli/run.go` (`keysCmd`), `cli/keysetup.go` (`keysSetupCmd`, `keyGuides`, `readSecret`); storage
  `keys/keys.go`. `ot keys` alone prints help (exit 0).
- `ot keys set <NAME>`: `ExactArgs(1)`. At a terminal, prompts `Value for NAME (typing is hidden):` on stderr and
  reads the value with echo off (`term.ReadPassword`); otherwise reads one line from stdin (pipes, CI). `--from-env
  VAR` copies an environment variable. Empty value → exit 2. Stores in the keychain (service `osintverse-ot`) and adds
  the name to `keys.json`. Keychain failure → exit 1. The name is not validated.
- `ot keys setup [tool...]`: refuses without a terminal (exit 2, code `needs_terminal`), so agents and scripts can't
  use it. Collects the keys the named tools declare (installed manifest, else the registry's latest), or every installed
  tool's; required keys first. For each: description, cost (`pricing`), sign-up URL with an offer to open it, then a
  hidden prompt (Enter skips). Keys already set (env or keychain) are skipped unless `--all`. `ot mcp`'s `key_setup`
  returns the same facts plus this command, never values.
- `ot keys list`: `NoArgs`. Prints names from `keys.json` (never values; includes `OTINSTALLER_TOKEN` after `ot
  login`), or "No keys stored."; env-only keys are not listed.
- `ot keys rm <NAME>`: `ExactArgs(1)`. Deletes from the keychain (not-found is fine) and the index. Exit 1 on keychain
  error.
- No API, no sign-in.

#### `ot doctor`
- File: `cli/run.go` (`doctorCmd`). Args: `NoArgs`. No flags.
- Checks, each printed `[ok  ]` / `[FAIL]`: containers (`<engine> info --format {{.ServerVersion}}`), pipx (fails only
  if neither pipx nor an engine), python (`python3`, else `python`; fails only if neither python nor an engine),
  cosign (never fails; informational), keychain (writes then deletes `OT_DOCTOR_CHECK`, which also rewrites
  `keys.json`), registry (`GET /tools?limit=1`). Then `Data directory: <ot home>`.
- Sign-in: no. Exit: 0; **5 when any check fails**, including the keychain and registry checks (not just a missing
  runtime).

### 1.3 Guides and docs

#### `ot guide`
- File: `cli/guide.go` (`guideCmd`). Alone prints help. Guide arguments go through `guideArg`: local paths are refused
  (exit 2, "give a guide as namespace/name[@version]").

#### `ot guide search [query]`
- Args: `MaximumNArgs(1)`.
- Flags: `--input` (string, guides about this input type), `--category` (string), `--level` (string: beginner,
  intermediate, advanced), `--format` (string: guide or reference), `--lang` (string, e.g. `en`), `--limit` (int, 25),
  `--json` (bool).
- API: `GET /guides?q=&input=&category=&level=&format=&lang=&limit=`.
- Output: table `GUIDE VERSION LEVEL TITLE` (`(reference)`, `[needs update]` marks), or "No guides found."
- Exit: 0; 2 for registry 4xx (`requestError`); 1 otherwise.

#### `ot guide read <namespace/name[@version]> [page]`
- Args: `RangeArgs(1, 2)`; page is a 1-based number or a page path, default `1`.
- Flags: `--list` (bool): list pages instead; `--plain` (bool): print the Markdown as written (also the case whenever
  stdout is not a terminal).
- API: `GET /guides/{ns}/{name}/{version|latest}/pages/{page}?format=md`; for a terminal, also `GET
  /guides/{ns}/{name}/{version}` to number links to other pages. `--list`: `GET /guides/{ns}/{name}[/{version}]`.
- Offline: if the page request fails with a non-registry error (network) and a saved copy exists, the copy from `ot
  guide get` is shown with a `note:`. `--list` falls back to the saved copy on **any** error.
- Terminal rendering: Glamour, width terminal−2 capped at 120 (100 if unknown); admonitions become bold labels, images
  become alt text, links to `.md` pages become `(page N)`. Footer on stderr: `Page X of Y of <ref> <version> · next:
  ot guide read …`.
- Exit: 0; 2 for registry 4xx; 1 otherwise.

#### `ot guide open <namespace/name[@version]> [page]`
- Args: `RangeArgs(1, 2)`.
- Opens `<site>/guides/<ns>/<name>[/<page without .md>][?v=<version>]` in the browser (`rundll32` on Windows, `open`
  on macOS, `xdg-open` elsewhere); a browser failure only prints a message.
- API: only when the page is given as a number: `GET /guides/{ns}/{name}[/{version}]` to map it to a path.
- Exit: 0; 2 for a page number out of range or a registry 4xx; 1 otherwise.

#### `ot guide get <namespace/name[@version]>`
- Args: `ExactArgs(1)`.
- API: `GET /guides/{ns}/{name}[/{version}]`, then `GET /guides/{ns}/{name}/{version}/pages/{path}?format=md` per page.
- Writes `<ot home>/guides/<ns>/<name>/<version>/<page paths>` and `guide.json`; refuses page paths that escape the
  folder. (The help text says `~/.ot/guides`; with `OT_HOME` it is `$OT_HOME/guides`.)
- Exit: 0; 2 for registry 4xx; 1 otherwise.

#### `ot guide tools <namespace/name[@version]>`
- Args: `ExactArgs(1)`.
- Flags: `-y`, `--yes` (bool): install without asking; `--native` (bool): install pipx tools on the host.
- API: `GET /guides/{ns}/{name}[/{version}]`, then the install calls for each tool not installed and still available.
- Prompt `Install N tool(s)? [y/N]:` (default no; "no" is exit 0 with "Nothing installed.").
- Exit: 0; 1 when any install failed ("N of M tool(s) failed to install"); 2 for registry 4xx on the guide.

#### `ot docs <namespace/tool> [page]`
- File: `cli/guide.go` (`docsCmd`). Args: `RangeArgs(1, 2)`; `@version` is refused (exit 2): docs are always latest.
- Flags: `--list` (bool), `--plain` (bool).
- API: `GET /tools/{ns}/{name}/docs/{page}?format=md`; `GET /tools/{ns}/{name}/docs` for `--list` and for link
  numbering in a terminal.
- Exit: 0; 2 for registry 4xx; 1 otherwise.

### 1.4 Publishing

#### `ot init [dir]`
- File: `cli/init_validate.go` (`initCmd`); files from `scaffold/scaffold.go`. Args: `MaximumNArgs(1)`, default `.`.
- Flags:

  | Flag | Type | Default | Meaning |
  | --- | --- | --- | --- |
  | `--kind` | string | detected (`scaffold.Detect`), else `docker` | docker, pipx or guide |
  | `--guide` | bool | false | shorthand for `--kind guide` |
  | `--name` | string | slug of the git remote's repo, else of the folder name | package name |
  | `--namespace` | string | slug of the git remote's owner | namespace |
  | `--summary` | string | none (required) | one-line summary |
  | `--license` | string | `MIT` | SPDX id |
  | `--category` | string | `utilities` | category |
  | `--input` | string | `domain` | main input type (guides: main topic) |
  | `--package` | string | the package name | PyPI package name (pipx only) |
  | `-y`, `--yes` | bool | false | accept defaults without prompting |
  | `--force` | bool | false | overwrite existing files |

- Prompts on stdout for anything not given by flag. Writes `otinstaller.yaml`, `README.md`, the release workflow
  (`.github/workflows/otinstaller-release.yml` or `.gitlab-ci.yml`), for docker an example `Dockerfile` (and `tool.py`
  for the starter) only when the repo has no Dockerfile, for guides `docs/index.md` and `docs/01-scope-and-legal.md`.
  Existing files are skipped unless `--force`.
- No API. Exit: 0; 2 for a bad kind, or a value with no default under `--yes` (summary, namespace without a remote),
  or a required answer missing at end of input; 1 on file errors.

#### `ot validate [path]`
- File: `cli/init_validate.go` (`validateCmd`). Args: `MaximumNArgs(1)`, default `.` (a directory means its
  `otinstaller.yaml`).
- Flags: `--tag` (string): the git tag being released, must equal `v<version>`; `--json` (bool): print
  `{"valid", "problems"}`; `--smoke` (bool): also install the package from the local manifest and run its
  `test.input`.
- Validates schema, semantics and files (README, docs/content pages) relative to the manifest's folder.
- API: none, except `--smoke` installs locally (no registry call, no ping).
- Exit: 0; **2** when problems are found; with `--smoke`: 2 when there is no `test.input`, 1 when the exit code differs
  from `test.expect_exit_code`, plus run codes 3, 4, 5, 124; "Guides have no smoke test." is exit 0.

#### `ot import <github-or-gitlab-url>...`
- File: `cli/import.go`. Args: any.
- Flags:

  | Flag | Type | Default | Meaning |
  | --- | --- | --- | --- |
  | `--id` | string | | continue an earlier import |
  | `--file` | string | | use this manifest file as the draft (`PATCH` with `yaml`) |
  | `--save` | string | | write the draft manifest to this file |
  | `--registry` | bool | false | keep the manifest on the registry instead of a PR/MR |
  | `--community` | bool | false | package a tool you don't own as a community wrapper (osintverse-community admins) |
  | `--wrapper` | string | `https://<provider>.com/osintverse-community/<name>` (asked) | wrapper repository for a community import |
  | `--draft` | bool | false | stop after saving the draft |
  | `-y`, `--yes` | bool | false | do not prompt; fail if the draft still needs input |
  | `--list` | bool | false | list your imports |
  | `--json` | bool | false | print JSON |

- Two or more URLs (without `--id`) start a bulk import (`--community` applies).
- API: `POST /imports` `{repo}` / `{repo, community: true}` / `{repos, community}` (bulk); `GET /imports/{id}`; `GET
  /imports` (`--list`); `PATCH /imports/{id}` (`yaml`, `kind`, or `manifest` changes); `POST /imports/{id}/finish`
  `{mode: pr|registry|connect}` or `{mode: wrapper, wrapper_repo}`.
- Sign-in: **yes, client-side** (no token → exit 2 "sign in first with `ot login`").
- Exit: 0; 2 for no token, no URL/`--id`, registry 4xx, draft problems, `--yes` with missing fields, undetectable kind
  with `--yes`, bad finish answer; **1** when the import is still `detecting` or detection `failed`.

#### `ot sync <namespace/name>`
- File: `cli/sync.go`. Args: `ExactArgs(1)`; local paths and `@version` refused (exit 2).
- Flags: `--log` (bool): show sync status and the last 50 events instead; `--json` (bool).
- API: `POST /packages/{ns}/{name}/sync`; `--log`: `GET /packages/{ns}/{name}/sync-log`.
- Sign-in: **yes, client-side** (exit 2).
- Exit: 0 for status `ok`, `archived`, `unarchived`; **1** for `unavailable`, `transfer_pending` or any other status;
  2 for registry 4xx (for example the 10-per-hour limit).

#### `ot release <version> [path]`
- File: `cli/release.go`. Args: `RangeArgs(1, 2)`; version `X.Y.Z[-pre]`, a leading `v` is stripped.
- Flags: `--remote` (string, `origin`): git remote to push to; `--no-push` (bool): commit and tag locally only.
- Guides only. Checks: git work tree, clean tracked files, tag not present locally, tag not on the remote (`git
  ls-remote`, skipped with `--no-push`), a top-level `version:` line. Rewrites `version:`, validates with `--tag`
  semantics (restores the file on failure), commits `Release X` if changed, `git tag -a vX -m "Release X"`, then `git
  push -q --atomic <remote> HEAD vX`.
- No API. Exit: 0; 2 for a bad version, unreadable manifest, a tool manifest, not a repo, dirty tree, existing tag,
  missing version line, validation problems; 1 for git failures (a failed push leaves the commit and tag locally).

#### `ot yank <namespace/name@version>`
- File: `cli/trust.go`. Args: `ExactArgs(1)`; the version is required.
- Flags: `--undo` (bool): un-yank.
- API: `POST /tools/{ns}/{name}/{version}/yank` or `/unyank`.
- Sign-in: registry-side only (owner). Exit: 0; 2 for a bad reference or registry 4xx; 1 otherwise.

#### `ot deprecate <namespace/name> --message <text> [--replacement <namespace/name>]`
- File: `cli/trust.go`. Args: `ExactArgs(1)`.
- Flags: `--message` (string, required unless `--undo`), `--replacement` (string), `--undo` (bool).
- API: `POST /tools/{ns}/{name}/deprecate` `{message, replacement}`; `--undo`: `DELETE /tools/{ns}/{name}/deprecate`.
- Sign-in: registry-side only. Exit: 0; 2 for a bad reference, missing `--message`, registry 4xx; 1 otherwise.

### 1.5 Trust

#### `ot report <namespace/name>`
- File: `cli/trust.go`. Args: `ExactArgs(1)`; `@version` is used as the version when `--version` is not given.
- Flags: `--reason` (string: malware, policy, impersonation, license, broken, other); `--details` (string; required
  by the registry except for broken); `--version` (string).
- Without `--reason`: opens `<site>/<ns>/<name>/report[?v=<version>]`, no API call.
- API: `POST /tools/{ns}/{name}/reports` `{reason, details, version?}`.
- Sign-in: no (anonymous unless a token is loaded). Exit: 0; 2 for a bad reference or registry 4xx; 1 otherwise.

#### `ot claim [namespace/name]`
- File: `cli/trust.go`. Args: `RangeArgs(0, 1)`.
- Flags: `--to` (string): your namespace that should receive it; `--verify` (string): check a pending claim again.
- API: `POST /tools/{ns}/{name}/claim` `{to?}`; `--verify <id>`: `POST /transfers/{id}/verify`.
- Prints the claim, a one-time claim token and instructions.
- Sign-in: **yes, client-side** (exit 2). Exit: 0; 2 for no token, no package and no `--verify`, bad reference,
  registry 4xx; 1 otherwise.

#### `ot transfer [namespace/name] --to <namespace>`
- File: `cli/trust.go`. Args: `RangeArgs(0, 1)`.
- Flags: `--to` (string), `--accept` (string: transfer id), `--decline` (string: transfer id). Precedence: `--accept`,
  then `--decline`, then package + `--to`.
- API: `POST /tools/{ns}/{name}/transfer` `{to}`; `POST /transfers/{id}/accept`; `POST /transfers/{id}/decline`.
- Sign-in: **yes, client-side** (exit 2). Exit: 0; 2 for no token, missing arguments, bad reference, registry 4xx;
  1 otherwise.

### 1.6 Account

#### `ot login`
- File: `cli/login.go`. Args: `NoArgs`.
- Flags: `--gitlab` (bool): sign in with GitLab; `--osintverse` (bool): sign in with an OSINTverse account (publishing
  still needs GitHub or GitLab). Both together → exit 2. Default provider `github`.
- API: `POST /auth/device/start` `{provider}`; then polls `POST /auth/device/token` `{provider, device_code,
  token_name: "ot CLI on <hostname>"}` every `interval` s (min 1; +5 s on `slow_down`) until `expires_in` (min 60 s).
- Stores the token in the keychain as `OTINSTALLER_TOKEN` (service `osintverse-ot`; the name is also added to
  `keys.json`).
- Exit: 0; 2 for both flags, `expired`, `denied`, or the deadline passing; 1 for registry/network errors (not wrapped)
  or a keychain write failure; Ctrl-C during the wait returns the context error (exit 1).

#### `ot logout`
- File: `cli/login.go`. Args: `NoArgs`. Deletes `OTINSTALLER_TOKEN` from the keychain and the index; does not revoke
  it on the server. Exit: 0; 1 on keychain error. (An `OTINSTALLER_TOKEN` environment variable keeps working.)

#### `ot profile [namespace]`
- File: `cli/profile.go`. Args: `MaximumNArgs(1)`; without one it uses the only namespace the user owns (`GET /me`).
- Flags: `--sync` (bool), `--set key=value` and `--unset key` (repeatable; keys name, bio, location, website, company,
  avatar, socials, about, pins, hide; `about=@file` or `@-` for stdin; socials and pins are comma lists); `--json`.
- API: `GET /namespaces/{ns}` (anonymous); edits `PATCH /me/namespaces/{ns}/profile`, then
  `POST /me/namespaces/{ns}/profile/sync` with `--sync`.
- Sign-in: needed for edits and for no namespace (exit 2). Exit: 0; 2 for usage, unknown keys and wrapped registry 4xx
  (including 429 `profile_sync_rate_limited`); 1 otherwise.

#### `ot whoami`
- File: `cli/login.go`. Args: `NoArgs`.
- API: `GET /me`. Prints `login (provider:login, ...)` and each namespace with role and status.
- Sign-in: **yes, client-side** (exit 2 "not signed in"). Exit: 0; 2 when not signed in or on 401; 1 otherwise.

### 1.7 Other

#### `ot feedback [message]`
- File: `cli/feedback.go`. Args: any (joined with spaces).
- Flags: `--kind` (string, default `other`: bug, idea, question, other; anything else → exit 2); `--email` (string):
  where to reply if not signed in; `--about` (string): the command or package it is about (sent as `page`).
- Without a message: reads up to 5000 bytes from stdin when stdin is not a terminal; if still empty, opens
  `<site>/feedback` (exit 0).
- API: `POST /feedback` `{kind, message, source: "cli", client: "ot <Version> (<GOOS>/<GOARCH>)", email?, page?}`.
- Sign-in: no (linked to the account when a token is loaded). Exit: 0; 2 for a bad kind or registry 4xx; 1 otherwise.

#### `ot self-update`
- File: `cli/selfupdate.go`; logic `selfupdate/selfupdate.go`. Args: `NoArgs`.
- Flags: `--check` (bool): only say whether an update is available.
- Network (not the registry): `GET https://api.github.com/repos/<Repo>/releases/latest`, then the release assets
  `checksums.txt`, `checksums.txt.sig` and `ot_<ver>_<os>_<arch>.tar.gz|.zip`. Verifies the Ed25519 signature with the
  built-in `PublicKey`, then the archive SHA-256, extracts `ot`, writes it next to the binary (`.ot-update-*`) and
  renames it in place (on Windows the old binary is moved to `<exe>.old`, removed on the next update).
- A `dev` build always considers the latest release newer.
- Exit: 0; **2** when the build has no release key; **4** when the download or any verification fails ("update
  refused"); 1 for release lookup or replace failures.

### Cobra built-ins

Not registered by ot, added by cobra v1.10.2 because `Root()` does not disable them:

- `ot help [command]`, and `-h`, `--help` on every command that does not disable flag parsing (`run`, `auto` and
  `playbook` handle `-h/--help` themselves).
- `ot completion bash|zsh|fish|powershell` (each with `--no-descriptions`). It runs the pre-run removal check like any
  other command.
- Hidden: `ot __complete` and `ot __completeNoDesc` (shell completion requests).
- `-v`, `--version` on the root only (because `Version` is set): prints `ot version <Version>`.

---

## 2. Global and persistent flags

`Root()` defines **no persistent flags**. The only root-level flags are cobra's `-h/--help` and `-v/--version`.
Settings that look global are environment variables or `config.json` (below), not flags. `SilenceUsage` and
`SilenceErrors` are on: errors are printed once by `Main` as `error: <message>` on stderr (nothing is printed for an
`ExitError` with a nil or empty error), and usage is never printed on error.

---

## 3. Exit codes

Constants in `cli/root.go`:

| Code | Constant | Meaning |
| --- | --- | --- |
| 0 | `ExitOK` | success |
| 1 | `ExitToolError` | tool failed, or any unclassified error (the default) |
| 2 | `ExitUsage` | bad usage, invalid manifest, or a registry 4xx wrapped by `requestError` |
| 3 | `ExitMissingKey` | a required API key is missing |
| 4 | `ExitTrust` | trust refusal (removed version, signature or hash mismatch, invalid registry manifest, refused self-update) |
| 5 | `ExitRuntimeMissing` | Docker/Podman or pipx missing; also any failed `ot doctor` check |
| 124 | `ExitTimeout` | tool timed out |
| 130 | `ExitInterrupted` | Ctrl-C during a saved run or a multi-tool run |

`ExitCodeFor(err)` uses `errors.As`, first match wins:

1. `*cli.ExitError` → its `Code` (created by `exitErr(code, …)` or `&ExitError{Code: …}`).
2. `*runner.UsageError` → 2.
3. `*runner.TrustError` → 4.
4. `*runner.RuntimeMissingError` → 5.
5. `*runner.TimeoutError` → 124.
6. anything else → 1.

Where each code is produced: 3 only by `loadSecrets` (`run`, `run --all`/`auto`/`playbook` mark the tool skipped
instead, `validate --smoke`); 124 only by `runner.Run`; 130 only by `execute` (cancelled context while saving) and
`runAll`. `Main` uses `signal.NotifyContext(os.Interrupt)`, so Ctrl-C cancels the context instead of killing ot.

Not obvious from the docs: errors raised by cobra itself (wrong argument count from `ExactArgs`/`RangeArgs`/`NoArgs`,
unknown flags, unknown subcommands, bad flag values such as `--limit abc`) are plain errors and exit **1**, not 2.
Registry errors exit 2 only where the command calls `a.requestError` (guide/docs/import/sync/report/claim/transfer/
yank/deprecate/feedback) or maps them itself (`install` 404 → 2, `whoami` 401 → 2); `search`, `info`, `login`,
`outdated`/`update` registry errors exit 1.

---

## 4. Environment variables

Read by the CLI (`os.Getenv` calls in `cli/`, plus the keychain lookup):

| Variable | Read in | Meaning | Default |
| --- | --- | --- | --- |
| `OT_HOME` | `state/state.go` `Home()` | ot's data directory | `%APPDATA%\ot` on Windows, else `~/.ot` |
| `APPDATA` | `state/state.go` `Home()` | Windows only: base of the default data dir | if unset on Windows, `~/.ot` is used |
| `OT_API_URL` | `state/state.go` `LoadConfig` | registry API base; overrides `config.json` `api_url` | `https://api.otinstaller.com/v1` |
| `OT_SITE_URL` | `state/state.go` `LoadConfig` | website base for `guide open`, `report` (form), `feedback` (form); overrides `site_url` | `https://otinstaller.com` |
| `OT_NO_TELEMETRY` | `state/state.go` `LoadConfig` | any non-empty value (even `0`) disables the `POST /installs` ping; overrides `telemetry` | telemetry on |
| `OT_RESULTS_DIR` | `results/results.go` `Dir` | results directory when `--results-dir` is not given (`~` expanded) | `./results` |
| `OTINSTALLER_RESULTS_DIR` | `results/results.go` `Dir` | legacy fallback after `OT_RESULTS_DIR` | `./results` |
| `OTINSTALLER_TOKEN` | `keys.Get(TokenKey)` in `NewApp` | registry API token; an env var wins over the keychain entry of the same name | keychain entry |
| `<SECRET_NAME>` (any manifest `secrets[].name`) | `keys.Get` in `loadSecrets` | a tool's key; env wins over the keychain | keychain entry |

Other environment handling:

- `os.UserHomeDir()` (so `HOME` / `USERPROFILE`) for `~/.ot` and `~` expansion; if it fails, the data dir is the
  relative `.ot`.
- ot **sets** `PIPX_HOME=<ot home>/pipx` and `PIPX_BIN_DIR=<ot home>/bin` for its pipx calls (it does not read them).
- Every child process (`docker`, `podman`, `cosign`, `pipx`, `git`, native pipx tools) gets ot's full environment plus
  the secrets. Containers receive only `HOME=/tmp` and the declared secrets (`-e NAME`). A native pipx tool therefore
  sees everything in ot's environment, including an `OTINSTALLER_TOKEN` variable if one is set.
- Engine/tool discovery uses `PATH` (`docker`, then `podman`; `cosign`; `pipx`, else `python3`/`python`/`py -m pipx`).

Not read by the CLI at run time (build or install-script only, listed for completeness): `OT_VERSION`,
`OT_RELEASE_REPO`, `OT_INSTALL_DIR`, `OT_DOWNLOAD_BASE`, `OT_NO_MODIFY_PATH` (install scripts); `OT_RELEASE_PUBLIC_KEY`,
`OT_RELEASE_KEY_FILE`, `RELEASE_OWNER`, `RELEASE_NAME`, `TAP_GITHUB_TOKEN` (GoReleaser).

ldflags-set variables (`cli/.goreleaser.yaml`, `-s -w -trimpath`, `CGO_ENABLED=0`):

| Variable | Set to | Default in code | Used by |
| --- | --- | --- | --- |
| `github.com/otinstaller/otinstaller/cli/internal/cli.Version` | `v{{ .Version }}` | `"dev"` | `--version`, User-Agent `ot/<Version>`, feedback `client`, self-update comparison |
| `…/internal/selfupdate.Repo` | `{{ RELEASE_OWNER or otinstaller }}/{{ RELEASE_NAME or ot }}` | `"otinstaller/ot"` | self-update release lookup |
| `…/internal/selfupdate.PublicKey` | `{{ .Env.OT_RELEASE_PUBLIC_KEY }}` (base64 Ed25519) | `""` | self-update signature check; empty → self-update exits 2 |

---

## 5. Files ot reads and writes

Data directory (`state.Home()`): `$OT_HOME` if set; else on Windows `%APPDATA%\ot` (if `APPDATA` is set); else
`~/.ot`; else `.ot` (relative) if the home directory cannot be found.

| Path | Written by | Contents |
| --- | --- | --- |
| `<home>/state.json` | `install`, `update`, `uninstall`, `run` (auto-install), `playbook -y`, `guide tools`, `validate --smoke` | `{"installed": {"ns/name": {ref, version, runtime, artifact, local_image, native, from_backup, installed_at, manifest, manifest_raw}}}`; written atomically via `state.json.tmp` and rename, mode 0600; directory created 0700 |
| `<home>/config.json` | never written by ot (read only) | `api_url`, `site_url`, `telemetry` (bool), `format` (default `ot run` format); env vars override the first three |
| `<home>/keys.json` | `keys set`, `keys rm`, `login`, `logout`, `doctor` | sorted JSON array of key names (never values), mode 0600 |
| `<home>/cache/removed.json` | pre-run check (24 h), `ot run` (1 h) | `{"fetched_at", "removed": [...]}` from `GET /removed`, mode 0644 |
| `<home>/guides/<ns>/<name>/<version>/` | `guide get` | every page as Markdown at its nav path, plus `guide.json` (the guide detail); read by `guide read` offline |
| `<home>/pipx/`, `<home>/bin/` | native pipx installs | ot's own `PIPX_HOME` and `PIPX_BIN_DIR`; native runs execute `<home>/bin/<command>[.exe]` |
| `<home>/playbooks/*.yaml|*.yml` | user | user playbooks (read only) |
| `./playbooks/*.yaml|*.yml` | user | project playbooks (read only; win over home and bundled) |
| OS keychain, service `osintverse-ot` | `keys set`, `login`, `doctor` (temporary `OT_DOCTOR_CHECK`) | key values and the `OTINSTALLER_TOKEN` token (Windows Credential Manager, macOS Keychain, Secret Service) |
| temp dirs `ot-wheel-*` (system temp) | pipx installs | downloaded wheel and generated Dockerfile; removed after install |
| `<exe>.ot-update-*`, `<exe>.old` | `self-update` | new binary staging; old binary on Windows |

Results (not under the data directory): base = `--results-dir`, else `$OT_RESULTS_DIR`, else
`$OTINSTALLER_RESULTS_DIR`, else `./results` relative to the current directory.

```
<base>/[cases/<case>/]<tool>/<target>/<YYYYMMDD-HHMMSS>_<tool>_<target>_<8 hex>.<ext>
<base>/[cases/<case>/]<tool>/<target>/<same stem>.meta.json
<base>/[cases/<case>/]<tool>/<target>/<same stem>.stderr.txt   (only if the tool wrote to stderr)
```

`<tool>` is the package name without the namespace; `<tool>`, `<target>` and `<case>` are sanitized (lowercase, only
`[a-z0-9._-]`, runs of `_` collapsed, trimmed, ≤ 80 chars, `target` if empty). The timestamp is UTC. `<ext>` is `json`,
`jsonl`, `csv`, else `txt` from `runtime.output_format`. The sidecar holds `command`, `tool`, `ref`, `tool_version`,
`runtime`, `target`, `case`, `input`, `started_at`, `ended_at`, `duration_seconds`, `exit_code` (-1 when it never
finished), `status` (`complete`, `failed`, `timeout`, `interrupted`), `output_path`, `sha256`, `bytes`, `stderr_path`,
`envelope` (1), `entities`, `warnings`. Secrets are never in it. A tool that never started leaves nothing behind.
Playbook runs default to the case `playbook-<name>`.

Telemetry ping: `POST <api>/installs` with `{"tool": "<ns/name>", "version": "<v>"}` after each successful install of
a registry package (not local manifests), 3 s timeout, errors ignored. Disabled by `OT_NO_TELEMETRY` or `config.json`
`"telemetry": false`. The code comment calls it anonymous, but `api.Client.do` attaches the `Authorization` header
whenever a token is loaded, so a signed-in user's ping carries their token.

Container sandbox (`runner.ContainerArgs`): `run --rm --name ot-<12 hex> --read-only --tmpfs /tmp:rw,size=256m
--cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --cpus 2 --user 65534:65534 -e HOME=/tmp`,
`--network none` unless the manifest has `network.egress: true`, `-e NAME` per secret, `-v <out-dir>:/out:rw`,
`--entrypoint <command[0]> <image> <command[1:]...>`. Sandboxed pipx images are built from `python:3.12-slim` as
`ot-local/<ns>-<name>:<version>` (`docker build --pull`).

---

## 6. Packages and tests

### `cli/internal` packages

| Package | One line |
| --- | --- |
| `api` | Registry HTTP client: `do`, error shape `*api.Error`, search, tool/manifest, install ping, device login, `/me`, guides and docs, imports, sync, removals, reports, claims and transfers, yank/deprecate, feedback |
| `cli` | Every cobra command, the `App` struct, exit codes, `ExitError`, `Main`, `ExitCodeFor` |
| `envelope` | The result envelope (`Version = 1`), `ParseOutput` for json/jsonl/csv/text, `Write` for json/raw/csv/table |
| `keys` | Keychain storage (service `osintverse-ot`), env-first `Get`, `keys.json` name index |
| `manifest` | Typed manifest, `Parse`/`ParseJSON`/`LoadFile`, schema + semantic + file validation, content rules, embedded schema (`go generate` from `spec/`) |
| `playbook` | Bundled and user playbooks: parse, directory order, `All`, `Find` |
| `results` | Saving runs (output, `.meta.json`, lazy `.stderr.txt`), `Dir`, `Sanitize`; `saved.go` reads them back for `extract` and `diff` |
| `runner` | Engine detection, install (docker pull + cosign, mirror and wheel fallbacks, pipx native or sandbox image), run, container args, input resolution, typed inputs, command building, target type detection with embedded `tlds.txt` |
| `scaffold` | Files `ot init` writes, git remote and kind detection, embedded release templates (`go generate` from `spec/templates`) |
| `selfupdate` | GitHub release lookup, Ed25519-signed checksums, archive SHA-256, extraction, atomic replace |
| `state` | Data directory, `state.json` load/atomic save, read-only `config.json` with env overrides |

### Test files

`api`, `keys`, `state` and `selfupdate` have **no test files** (`selfupdate` is exercised by `TestSelfUpdate` in
`cli/trust_test.go`).

| File | Covers |
| --- | --- |
| `cli/cli_test.go` | Shared helpers (`newTestApp`, `fakeExec`); `validate` output and exit codes, `init` then `validate`, `init` not overwriting, running a local manifest, run exit codes, `parseRunArgs` |
| `cli/run_test.go` | Typed-input parsing, typed run saving results, `--no-save` and `--results-dir`, typed-input errors, `run --all`, Ctrl-C keeping partial output (exit 130) |
| `cli/auto_test.go` | `ot auto`: type guessing, `--dry-run`, `--type`, `--live` progress lines, and errors (bad `--type`, `--type` with two targets, no matching tool, `--all`; plus `run --dry-run` without `--all`) |
| `cli/playbook_test.go` | `ot playbook`: `--list` with a user playbook, prefixed and guessed targets, and errors (missing tools, no matching inputs, no typed input, unknown playbook, `--all`) |
| `cli/saved_test.go` | `ot extract` and `ot diff` against saved runs |
| `cli/update_test.go` | `ot outdated --json` and `ot update` (named, `--all`) against a fake registry (update available, removed, not in registry), plus usage errors |
| `cli/guide_test.go` | Guide search and read, terminal rewriting (`forTerminal`), Glamour rendering, `guide get` then offline read, `guide tools`, `guide open` and `docs`, request IDs on server errors, guide content validation |
| `cli/import_test.go` | Import wizard completing a draft and opening a PR, `--registry` with `--yes`, community wrapper, bulk import and `--list` |
| `cli/login_test.go` | Device-flow login (GitHub) and `--osintverse` |
| `cli/release_test.go` | `ot release` with real git: happy path, refusals (dirty tree, existing tag), tools refused, `--no-push` |
| `cli/sync_test.go` | `ot sync` and `--log` |
| `cli/profile_test.go` | `ot profile`: show, `--set`/`--unset`, `--sync`, rate limit, `--json` |
| `cli/trust_test.go` | report/claim/transfer against a fake registry, removed-package warnings and refusal, `self-update` with a signed fake release |
| `cli/feedback_test.go` | `ot feedback`: message with `--kind`/`--about`, piped stdin with `--email`, bad kind exits 2 |
| `envelope/envelope_test.go` | `ParseOutput` per format; `Write` formats |
| `manifest/validate_test.go` | Every valid fixture passes, every invalid fixture's first code, tag mismatch, file checks, embedded schema equals `spec/schema/v1.json` |
| `manifest/seed_test.go` | Every `seed/*/*/otinstaller.yaml` validates with its files (at least 50) |
| `playbook/playbook_test.go` | Bundled playbooks, bundled tools exist in the seed, later dirs win, parse errors, a broken file is an error |
| `results/results_test.go` | `Sanitize`, `Dir` precedence (flag, `OT_RESULTS_DIR`, `OTINSTALLER_RESULTS_DIR`), start/finish sidecar, stderr file only when written |
| `results/saved_test.go` | `Outputs` and `Extract`; `Diff` |
| `runner/runner_test.go` | `BuildCommand` (dropping optional args, no re-expansion), `ResolveInputs`, sandbox container args, docker install and run, no engine (exit 5), signature failure refuses, wheel hash check, sandboxed pipx image build |
| `runner/backup_test.go` | Mirror fallback with the same signature, no fallback for other failures, bad mirror signature refused, wheel fallback to the registry copy, wheel backup when PyPI dropped the file |
| `runner/typed_test.go` | `ParseTypedInput`, `ApplyTyped` |
| `runner/detect_test.go` | `DetectType` order; detected prefixes are known typed prefixes |
| `scaffold/scaffold_test.go` | Files per host (GitHub/GitLab), templates equal `spec/templates`, example Dockerfile, every workflow is valid YAML |

---

## 7. Docs drift: `web/src/pages/docs/cli.md` and `cli/README.md`

`cli/README.md` is a short intro (doctor, search, a `holehe` example, links, self-update). It documents no flags, so
nothing in it is wrong. `web/src/pages/docs/cli.md` was brought level with `ot <command> --help` on 22 October 2026:
every command and flag above appears there, with exit code 130, the cobra exit-1 caveat, the wider meanings of exit
codes 4 and 5, `OTINSTALLER_RESULTS_DIR`, keys from environment variables and `config.json`. When a flag is added or
renamed, update that page in the same commit; there is no test that compares them.
