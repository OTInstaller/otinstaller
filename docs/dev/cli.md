# `ot` CLI reference

Read from the code in `cli/`. Every statement below comes from the
Go code; file paths are relative to `cli/internal/` unless shown otherwise.

Conventions used here:

- "API" paths are relative to the configured API base (`OT_API_URL`, default `https://api.otinstaller.com/v1`). All
  calls go through `api.Client.do` (`api/client.go`), which sends `User-Agent: ot/<Version>`, `Accept:
  application/json`, and `Authorization: Bearer <token>` when a token is loaded (keychain or `OTINSTALLER_TOKEN`),
  except for the calls made through `anon()`, which never carry it: search, tool detail, manifest, guide search,
  guides and guide pages, tool docs, `/removed`, the install ping and the device-login start and poll. So public reads
  stay anonymous and edge cached even when signed in. HTTP timeout 30 s.
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
runs, extract, diff, list, outdated, update, uninstall, keys, doctor, login, logout, whoami, import, publish, namespace,
sync, guide, docs, report, feedback, claim, transfer, yank, deprecate, self-update, release, mcp, pivot, token, profile.
38 top-level commands, plus subcommands `keys set|setup|list|rm`, `guide search|read|open|get|tools`,
`mcp install|audit|policy|tools` (with `mcp policy reset`), `token create|list|revoke` and `namespace create`.

Commands that print data also print JSON with the global `--json` flag (or `OT_OUTPUT=json`); the per-command
`--json` rows below are that flag. Nothing prompts without a terminal: see [section 2](#2-global-and-persistent-flags).

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

#### `ot install <namespace/name[@version]> ...`
- File: `cli/packages.go` (`installCmd`, `installMany`, `install`). Args: `MinimumNArgs(1)`; each may also be a local
  manifest path. Every reference is parsed first, so a bad one exits 2 before anything installs; repeated arguments
  install once.
- Flags: `--native` (bool, false): install pipx tools on the host instead of in a container.
- Several packages: `installMany` installs them one after another and goes on after a failure (printing
  `error: <ref>: <message>` on stderr in text mode), except a missing container engine (`RuntimeMissingError`), which
  stops it: the rest are `not_tried`. `guide tools` and `playbook -y` use it too.
- After installing, text mode prints `Try it: <runner.ExampleCommand>` (or `Try them:` and one command per line) and
  ``Needs a key: run `ot keys setup <ref>` to set <NAME>`` for required keys not set (`missingKeys` in `run.go`), on
  stderr.
- JSON: one package prints its install record plus `example` and `missing_keys` (omitted when none); several print
  `[{ref, status (installed, failed, not_tried), version, example, missing_keys, error, exit_code}]`, then the error.
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
  (other registry errors, pull or build failures). With several packages: 5 when the engine is missing; otherwise the
  code every failed install shares ("N of M failed to install: …", and their common JSON code), or 1 when they differ.

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
- API: `GET /tools/{ns}/{name}` and `GET /tools/{ns}/{name}/versions` per installed package (`api.Client.Tool` and
  `Versions`), four packages at a time (`checkConcurrency`); rows keep the installed order.
- Output: table `PACKAGE INSTALLED LATEST STATUS`; statuses `up to date`, `update available`, `removed` (410 for the
  package, or the installed version listed as `removed`), `not in registry` (404), `error`, with notes (`moved to
  …`) and flags in brackets. JSON rows: `{ref, installed, latest, status, note, flags, replacement}`. `flags` is always
  an array of `deprecated`, `possibly_broken` (health `broken`), `yanked` (the installed version), `source_unavailable`
  and `moved`, whatever the status; `replacement` is the deprecation's replacement, else `moved_to`. Each flag also
  prints one `warning:` line on stderr, in JSON mode too. "Nothing installed yet." goes to **stderr**.
- Exit: 0 always on a completed check (it changes nothing and does not fail on outdated or errored rows); 1 on state
  errors.
- Newer ot (`noteNewerOT`, `latestOT` in `cli/selfupdate.go`): after the table, also with nothing installed, a `note: ot
  vX is out (you have vY); \`ot self-update\` installs it` on stderr when the latest release is newer. The release is
  looked up at most once a day (`GET https://get.otinstaller.com/ot/latest`, else the GitHub API; 3 s) and kept in
  `<ot home>/cache/ot-latest.json`, a failed lookup too. Never for a `dev` build, under `ot mcp`, with `CI` set or with
  `OT_NO_UPDATE_CHECK=1`.

#### `ot update [namespace/name ...]`
- File: `cli/update.go` (`updateCmd`). Args: any number.
- Flags: `--all` (bool, false): update every installed package; `--json` (bool, false).
- API: as `outdated`, then the `install` calls (`GET …/manifest`, `POST /installs`) for each package with an update.
  Native installs stay native. Picks packages by `status` (`update available`), plus packages that moved (`up to date`
  or `update available` with a `moved_to`): those are installed under the new name, the old `state.json` entry is
  dropped and its image removed unless the new install uses the same one (`forgetOldName`; native pipx installs share
  their package, so nothing is uninstalled). Such a row is reported under the new name with the note `from <old ref>
  <version>`. An updated row loses its `yanked` and `moved` flags.
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
  | `--max-raw` | int | `$OT_MAX_RAW`, else no limit | leave `raw` out of the envelope when the output is over this many bytes |

  With `--all`, `-f` also takes `jsonl` (one summary row per line as each tool finishes).

  | Switch | Meaning |
  | --- | --- |
  | `-h`, `--help` | print the run help, exit 0 |
  | `--json` | same as `-f json` |
  | `--native` | install/run pipx tools on the host instead of in a container (applies to an install triggered by `run`; the installed record decides how it runs) |
  | `-y`, `--yes` | install without asking if the tool is not installed; without a terminal, also the consent for a tool that isn't passive (`consent.go`) |
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
- Without a terminal (piped stdin, `OT_NONINTERACTIVE=1`, CI), `cliConsent` (`consent.go`) classifies every planned
  run with the agent policy (`agent.Classify`): a refused tool stops everything with exit 4; tools that aren't passive
  stop the run with exit 2, code `consent_required`, unless `--yes` was given or `OT_CONSENT=off` is set. Each such
  run is then written to `<ot home>/agent-audit.jsonl` (consent `policy`, `flag` or `off`).
- The envelope carries `run_id`, `ot_version` and `client` (`cli`, `ci` when `CI` is set, `mcp` under `ot mcp`). When a
  text or CSV tool reports no entities, `runner/textentities.go` adds the emails, URLs, IP addresses and domains its
  output mentions (up to 200, `confidence: low`, `found_in: "text output"`, leaving out the run's own inputs, an
  email's own domain and file-extension lookalikes).
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
- No installed tool takes any typed input (`planAll` returns `*noToolsError`, `starter.go`): for each input type,
  `playbook.Starter` picks the bundled playbook whose main `inputs` entry is that type (never a user playbook). At a
  terminal, and not for `--dry-run`, `offerInstall` calls `GET /tools/{ns}/{name}` for each of its tools, leaves out
  deprecated, `health: broken`, removed and unknown ones (a `note:` each) and those without the input type, prints
  `ref version: summary (agent.Describe effects)` and asks `Install N tools and run? [y/N]` on stderr. Yes:
  `installMany`, then `planAll` again (failed installs are reported; the rest run unless none installed or the engine
  is missing). Otherwise exit 2, `not_installed`, with `ExitError.Hint` naming `ot playbook <starter> <type>:<value>
  --yes` (or `ot search --input <type>` when no playbook fits, as for `url`). An unreachable registry exits 1.
- API: `GET /removed` (if the cache is older than 1 h); install calls when installing; none for the run itself.
- Sign-in: no.
- Exit codes:
  - 0: tool exited 0 (single run) / every row `complete` or `skipped` (`--all`), or help, or `--dry-run`.
  - 1: tool exited non-zero ("`<ref> exited with code N`"); with `--all` any row not `complete`/`skipped`; results
    folder cannot be created; other errors.
  - 2: argument errors (`runner.UsageError`), unknown `-f` format, `--dry-run` without `--all`, no package (prints the
    help and exits 2), `--all` misuse, "no installed tool has a … input" (`not_installed`, with a hint), declined
    install prompt, a tool that isn't installed when there is no terminal to ask (`not_installed`), `consent_required`.
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
- `--list`: table `NAME TAKES DESCRIPTION TOOLS SOURCE` (TAKES is `inputs`, or `-`); JSON is the playbooks with
  `inputs` always an array.
- Sources, later winning on a name clash: bundled (`playbook/bundled/`, all `osintverse-community/`, none needing a
  key: `domain-recon`: dnstwist, crtsh-subdomains; `username-investigation`: sherlock, maigret; `email-investigation`:
  holehe, user-scanner, checkdmarc, dns-records; `phone-investigation`: phone-parse, phoneinfoga, numint;
  `ip-investigation`: ipwhois, naabu), `<ot home>/playbooks/*.yaml|*.yml`, `./playbooks/*.yaml|*.yml`. YAML keys:
  `name` (defaults to the file stem), `description`, `inputs` (input types the playbook is for, main one first; each
  one of username, email, domain, phone, ip, url, no duplicates; optional), `tools` (`ns/name`, no duplicates,
  namespace required), `case`,
  `requires_target` (ignored). A broken file is an error.
- Missing tools without `-y`: at a terminal, `offerInstall` (`starter.go`) describes them from the registry, leaves out
  deprecated, broken and removed ones, and asks `Install N tools and run? [y/N]`; on yes the playbook runs with the
  tools that are installed. Without a terminal, or after a no: exit 2, `not_installed`, hint `ot install <tools>` or
  `ot playbook <name> <inputs> --yes`. With `-y`: installs them all with `installMany` (`GET …/manifest`,
  `POST /installs`), then runs; a failed install stops the playbook with that install's code (or the failures' common
  one). Prints `Playbook <name>: <tools>` on stderr (table). Tools with no input of the given types are
  listed as `skipped`.
- Sign-in: no. Exit: as `ot run --all`; also 2 for an unknown playbook, a broken playbook file, a bad list format, or
  when none of the playbook's tools can run with the inputs; install errors propagate their own codes (4, 5, 1).

#### `ot pivot <run-id | saved file>`
- File: `cli/pivot.go`. Args: `ExactArgs(1)`.
- Flags: `--registry` (bool): also list tools that aren't installed (asks the registry); `--limit` (int, 25): at most
  this many pivots.
- Argument: an existing file (a saved output, or its `.meta.json`), else a run id looked up under the results
  directory and `<ot home>/results`. Reads the run's entities from the sidecar and, through the embedded
  `spec/pivots.json`, lists for each entity worth following the input type it fits and the installed tools that take
  it, with an `ot run` line for each. The run's own inputs are left out. Nothing is run.
- API: only with `--registry` (`GET /pivots`). Exit: 0; 2 when the run or its sidecar can't be found.

#### `ot runs [run-id]`
- File: `cli/runs.go` (`runsCmd`, `listSavedRuns`, `showRun`). Args: `MaximumNArgs(1)`.
- Flags: `--tool` (`ns/name` or `name`), `--target`, `--case` (reads `<dir>/cases/<case>`), `--status` (`complete`,
  `failed`, `timeout` or `interrupted`; anything else exit 2), `--since` (duration, default `168h`; `0` for all),
  `--limit` (int, 20; `0` for all), `--results-dir` (read only that folder), `--json`.
- Reads `resultDirs()`: the results dir (`$OT_RESULTS_DIR`, else `./results`) and `<ot home>/results`, merged newest
  first by the time stamp in the file names. `listSavedRuns` is also what MCP's `list_runs` uses (with only the results
  dir, as before).
- Output: table `RUN STARTED TOOL TARGET STATUS ENTITIES CASE` (a `note:` on stderr when `--limit` cut it, and a line
  pointing at `ot runs <run-id>` and `ot pivot`), or "No saved runs from the last 7 days under …"; JSON is an array of
  `list_runs` rows. With a run id (`findSavedRunIn`): tool, target, status, exit code, entity count, duration, start
  time, case, saved path, warnings, the first ten distinct entities and, when it found any, a line suggesting `ot pivot <id>`; JSON is the sidecar.
- No API. Exit: 0, also when nothing is found; 2 for a bad flag value or an unknown run id (`run_not_found`).

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

#### `ot mcp`
- File: `cli/mcp_cmd.go` (the command and its subcommands), `mcp_server.go` (server, consent flow), `mcp_tools.go`
  (read-only tools), `mcp_run.go` (install, uninstall, run, cancel), `mcp_content.go` (resources and prompts); rules
  in `internal/agent`.
- `ot mcp`: `NoArgs`; flag `--results-dir` (string): where runs are saved, else `$OT_RESULTS_DIR`, else
  `<ot home>/results` (not `./results`, since a client starts the server in an arbitrary folder). Loads the policy (a
  broken policy file → exit 2), sets `AgentMode`, prints one line on stderr and serves MCP over stdio until the client
  goes away; then stops running containers (15 s) and records those runs as interrupted.
- `ot mcp install <claude|claude-desktop|cursor|vscode|codex|gemini>`: `ExactArgs(1)`; `--print` (bool) prints the
  configuration instead of writing it. `claude` runs `claude mcp add --scope user` (printed when `claude` isn't on the
  PATH); the others edit `claude_desktop_config.json`, `~/.cursor/mcp.json`, `.vscode/mcp.json` (current folder),
  `~/.codex/config.toml` or `~/.gemini/settings.json`, pointing at this binary's resolved path.
- `ot mcp audit`: `--since` (duration, default `24h`). Lists `agent-audit.jsonl` entries (JSON with `--json`), or
  "Nothing in the last …".
- `ot mcp policy`: prints the policy file's path and the effective policy (defaults merged in); `ot mcp policy reset`
  writes the defaults to the file, replacing it.
- `ot mcp tools`: lists the server's tools, resources and prompts as a client sees them (full definitions with
  `--json`). The descriptions must match `web/src/pages/docs/mcp-tools.md` (`TestMCPToolsDocsMatch`).
- No API for the command itself; the tools call the registry as the matching commands do. Sign-in: no.

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
- Installs through `installMany`, so it stops when Docker or Podman is missing (the rest are `not_tried` in JSON).
- Exit: 0; as `ot install` with several packages when any install failed (5 for a missing engine, else the failures'
  common code or 1; with one tool to install, that install's own code); 2 for registry 4xx on the guide.

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

#### `ot publish [path]`
- File: `cli/publish.go`. Args: `MaximumNArgs(1)`, default `.` (a directory means its `otinstaller.yaml`).
- Flags: `--wait` (bool): follow the job until `published`, `rejected`, `error` or `awaiting_review`; `--timeout`
  (duration, default 5m, 90m with `--wait`); `--dry-run` (bool): validate and list the files, upload nothing (no sign-in
  needed); `--json` (bool): print the final job.
- Validates like `ot validate` (problems printed on stderr, exit 2, nothing uploaded), then `manifest.BundleFiles`
  picks the files (`cli/internal/manifest/bundle.go`). These are the manifest (always as `otinstaller.yaml`), the
  README and docs/content pages, and every PNG/JPEG/WebP/SVG of at most 2 MB under the folder, skipping dot folders,
  `node_modules`, `vendor`, `dist`, `build` and `__pycache__`. Over 24 MiB or 300 files it keeps only images the pages
  show (Markdown or `<img>`), and errors if still over.
- API: `POST /publish?namespace=&name=&version=` as `multipart/form-data`, one part per file named by its path (a
  10-minute HTTP timeout; `api.(*Client).Publish`), then `GET /me/publish-jobs/{id}` every 3 s (`publishPoll`, through
  `pollSleep`), printing each new status on stderr.
- Sign-in: **yes, client-side** except `--dry-run` (exit 2 "sign in first with `ot login`, or set OTINSTALLER_TOKEN").
- Exit: 0 when queued, scanning, awaiting review or published (a timeout also exits 0 with where to follow it); **2**
  for local problems, registry 4xx (`a.requestError`) or a release rejected with problems; **1** when a check refused it
  (`signature_mismatch`, `smoke_test_failed`, ...), with the code as the JSON error's `code`.

#### `ot namespace create <name>`
- File: `cli/namespace.go`. Args: `ExactArgs(1)`.
- Flags: `--org` (bool): `kind: org` instead of `user`; `--json`.
- API: `POST /namespaces` `{name, kind}`. Sign-in: **yes, client-side** (exit 2). Exit: 0; 2 for registry 4xx
  (`namespace_taken`, `namespace_reserved`, `namespace_account_required`, `namespace_limit`, `insufficient_scope`).

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
  still needs GitHub or GitLab). Both together → exit 2. Default provider `github`. `--scope` (string list: `read`,
  `publish`, `manage`, `feedback`; default all four; an unknown one → exit 2) limits the token; `--print-token`
  (bool) prints the token instead of saving it to the keychain (for CI secrets).
- API: `POST /auth/device/start` `{provider}`; then polls `POST /auth/device/token` `{provider, device_code,
  token_name: "ot CLI on <hostname>", scopes?}` every `interval` s (min 1; +5 s on `slow_down`) until `expires_in`
  (min 60 s). The OSINTverse path on the server ignores `scopes` (a known gap).
- Stores the token in the keychain as `OTINSTALLER_TOKEN` (service `osintverse-ot`; the name is also added to
  `keys.json`), unless `--print-token`.
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

#### `ot token` (`token create|list|revoke`)
- File: `cli/token.go`; client `api/tokens.go`. `ot token` alone prints help.
- `ot token create <name>`: `ExactArgs(1)`. `--scope` (string list; default `read`, `publish`, `manage`,
  `feedback`; `staff` tokens are made on the website only), `--expires` (int days, 1–365; 0 means the server default
  of 90). `POST /me/tokens`. Prints the token once on stdout and its id, scopes and expiry on stderr (all as JSON with
  `--json`).
- `ot token list`: `NoArgs`. `GET /me/tokens`: id, name, scopes, last used, expiry; never values.
- `ot token revoke <id>`: `ExactArgs(1)`. `DELETE /me/tokens/{id}`.
- Sign-in: **yes, client-side** (exit 2). Registry 4xx go through `requestError` (exit 2), including
  `insufficient_scope` when the signed-in token can't mint what was asked.

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
- Network (not the registry): `GET https://get.otinstaller.com/ot/latest` (`selfupdate.LatestVersion`; a tag
  matching `^v\d+\.\d+\.\d+$`), the assets then named under `https://github.com/<Repo>/releases/download/<tag>/`;
  if that fails, `GET https://api.github.com/repos/<Repo>/releases/latest` and its asset URLs. Then the release assets
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

`Root()` defines one persistent flag, `--json` (bool): commands print JSON, and an error is printed as one line of
JSON on stderr, `{"error": {code, message, hint?, docs, exit_code, request_id?, problems?}}`
(`spec/schema/error-v1.json`, the same shape as the API's errors). `OT_OUTPUT=json` turns it on for every command, and
`ot run`, `auto` and `playbook` (which parse their own arguments) honour `--json` themselves (`jsonRequested`). The
`code` is the registry's own code, else `ExitError.Reason` (`input_required`, `consent_required`, `needs_terminal`,
`not_installed`, ...), else one that follows from the exit code (`machine.go`); `hint` is the registry's hint or
`ExitError.Hint`. Otherwise errors are printed once by `Execute` as `error: <msg>` on stderr, followed by
`ExitError.Hint` on its own line when there is one (nothing for an `ExitError` with a nil or empty error). `SilenceUsage` and
`SilenceErrors` are on, so usage is never printed on error. Cobra adds `-h/--help` and `-v/--version`.

**No prompts without a terminal** (`machine.go`, `interactive()`): when stdin isn't a terminal, `OT_NONINTERACTIVE=1`
is set, or under `ot mcp`, any question ot would ask (install now?, `init`/`import` confirmations, `guide tools`) is
an exit 2 `input_required` error naming the flag to pass instead.

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
| `OT_OUTPUT` | `root.go` `jsonMode` | `json` turns on `--json` for every command | off |
| `OT_NONINTERACTIVE` | `machine.go` `interactive` | `1`: never prompt, as if there were no terminal | prompts at a terminal |
| `OT_CONSENT` | `consent.go` `cliConsent` | `off`: unattended runs need no `--yes` (still audited) | consent checked |
| `OT_MAX_RAW` | `run_cmd.go` | default for `--max-raw` (bytes) | no limit |
| `CI` | `run_cmd.go` `clientKind`, `selfupdate.go` `latestOT` | any value: the envelope's and audit log's `client` is `ci`, and the install ping says so; no newer-ot check | `cli` |
| `OT_NO_UPDATE_CHECK` | `selfupdate.go` `latestOT` | `1`: `ot outdated` never looks up the latest ot release | checked daily |
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
| `<home>/cache/ot-latest.json` | `ot outdated` (24 h) | `{"checked_at", "version"}`: the latest ot release, or the last one known when the lookup failed, mode 0644 |
| `<home>/guides/<ns>/<name>/<version>/` | `guide get` | every page as Markdown at its nav path, plus `guide.json` (the guide detail); read by `guide read` offline |
| `<home>/pipx/`, `<home>/bin/` | native pipx installs | ot's own `PIPX_HOME` and `PIPX_BIN_DIR`; native runs execute `<home>/bin/<command>[.exe]` |
| `<home>/agent-policy.json` | `ot mcp policy reset` (else the user) | the agent policy: `enabled`, `mode`, `allow_tools`, `deny_tools`, `auto_approve`, `consent_ttl_minutes`, `max_runs_per_hour`, `max_parallel`, `max_runs_per_target_per_hour`, `max_output_chars`, `allow_install`, `redact_targets_in_audit`; missing fields keep their defaults, a broken file is an error |
| `<home>/agent-audit.jsonl` (+ `.1` to `.4`) | `ot mcp`, unattended `ot run`/`--all`/`playbook`/`auto` | one JSON line per install, uninstall or run: time, client, action, tool and digest, inputs (or only their hash), class, consent, outcome, run id; rotated at 10 MiB |
| `<home>/results/` | `ot mcp` | default results directory under `ot mcp` |
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

Telemetry ping: `POST <api>/installs` with `{"tool": "<ns/name>", "version": "<v>", "client": "cli|ci|mcp"}` after each successful install of
a registry package (not local manifests), 3 s timeout, errors ignored. Disabled by `OT_NO_TELEMETRY` or `config.json`
`"telemetry": false`. It goes through `anon()`, so it never carries the token, even when signed in. The API counts it
once per address, version and day (a salted hash of the address and version in `rate_limits`, removed by the nightly purge once the window is over) and keeps only
per-version and per-client-kind daily counts.

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
| `agent` | Consent classes (`Classify`, `Describe`), the policy file (`LoadPolicy`, `DefaultPolicy`), sessions (`DecideRun`, approvals, limits), consent tokens (`CallHash`, `Seal`/`Open`, single use), the audit log (`Record`, `ReadAudit`, rotation) |
| `api` | Registry HTTP client: `do`, error shape `*api.Error`, search, tool/manifest/versions, install ping, device login, `/me`, tokens, guides and docs, imports, sync, removals, reports, claims and transfers, yank/deprecate, feedback |
| `cli` | Every cobra command, the `App` struct, exit codes, `ExitError`, `Main`, `ExitCodeFor`, JSON errors (`machine.go`), the MCP server (`mcp_*.go`) |
| `envelope` | The result envelope (`Version = 1`), `ParseOutput` for json/jsonl/csv/text, `Write` for json/raw/csv/table |
| `keys` | Keychain storage (service `osintverse-ot`), env-first `Get`, `keys.json` name index |
| `manifest` | Typed manifest, `Parse`/`ParseJSON`/`LoadFile`, schema + semantic + file validation, content rules, embedded schema (`go generate` from `spec/`) |
| `playbook` | Bundled and user playbooks: parse, directory order, `All`, `Find` |
| `results` | Saving runs (output, `.meta.json`, lazy `.stderr.txt`), `Dir`, `Sanitize`; `saved.go` reads them back for `extract` and `diff` |
| `runner` | Engine detection, install (docker pull + cosign, mirror and wheel fallbacks, pipx native or sandbox image), run, container args, input resolution, typed inputs, command building, target type detection with embedded `tlds.txt` |
| `scaffold` | Files `ot init` writes, git remote and kind detection, embedded release templates (`go generate` from `spec/templates`) |
| `selfupdate` | Release lookup (get.otinstaller.com, else the GitHub API), Ed25519-signed checksums, archive SHA-256, extraction, atomic replace |
| `specfiles` | Embedded copies of `spec/schema/{envelope,run-all,error}-v1.json`, `spec/pivots.json` and `spec/types.json` (`go generate`) |
| `state` | Data directory, `state.json` load/atomic save, read-only `config.json` with env overrides |

`cli/cmd/mcpb` (not under `internal/`) packs the release binaries into MCP Bundles and writes the MCP Registry
`server.json`; the release workflow runs it after GoReleaser.

### Test files

`api`, `keys` and `state` have **no test files** (`api` is exercised through the commands' fake registries).
`selfupdate_test.go` covers `LatestVersion` and the lookup order; downloads and signatures are exercised by
`TestSelfUpdate` and `TestSelfUpdateViaLatestURL` in `cli/trust_test.go`.

| File | Covers |
| --- | --- |
| `cli/cli_test.go` | Shared helpers (`newTestApp`, `fakeExec`); `validate` output and exit codes, `init` then `validate`, `init` not overwriting, running a local manifest, run exit codes, `parseRunArgs` |
| `cli/run_test.go` | Typed-input parsing, typed run saving results, `--no-save` and `--results-dir`, typed-input errors, `run --all`, Ctrl-C keeping partial output (exit 130) |
| `cli/runs_test.go` | `ot runs`: none yet, newest first, each filter, the default `--since`, the table, one run in text and JSON, unknown ids (`run_not_found`), a bad `--status`, `--results-dir` |
| `cli/auto_test.go` | `ot auto`: type guessing, `--dry-run`, `--type`, `--live` progress lines, and errors (bad `--type`, `--type` with two targets, no matching tool, `--all`; plus `run --dry-run` without `--all`) |
| `cli/playbook_test.go` | `ot playbook`: `--list` with a user playbook and the TAKES column, prefixed and guessed targets, and errors (missing tools, no matching inputs, no typed input, unknown playbook, `--all`) |
| `cli/saved_test.go` | `ot extract` and `ot diff` against saved runs |
| `cli/update_test.go` | `ot outdated --json` and `ot update` (named, `--all`) against a fake registry (update available, removed, not in registry), plus usage errors; lifecycle flags, their warnings and the table, `yanked` cleared by an update, and moved packages installed under their new name (old image removed only when not shared) |
| `cli/guide_test.go` | Guide search and read, terminal rewriting (`forTerminal`), Glamour rendering, `guide get` then offline read, `guide tools`, `guide open` and `docs`, request IDs on server errors, guide content validation |
| `cli/import_test.go` | Import wizard completing a draft and opening a PR, `--registry` with `--yes`, community wrapper, bulk import and `--list` |
| `cli/login_test.go` | Device-flow login (GitHub) and `--osintverse` |
| `cli/release_test.go` | `ot release` with real git: happy path, refusals (dirty tree, existing tag), tools refused, `--no-push` |
| `cli/sync_test.go` | `ot sync` and `--log` |
| `cli/publish_test.go` | `ot publish` against a fake registry: the files uploaded (and the part names), the query, stopping after validation, `--wait` to the outcome, rejections with problems (exit 2) and by a check (exit 1, JSON code), `--dry-run` without a token, nothing uploaded for an invalid manifest; `ot namespace create` with `--org` and a taken name |
| `cli/profile_test.go` | `ot profile`: show, `--set`/`--unset`, `--sync`, rate limit, `--json` |
| `cli/trust_test.go` | report/claim/transfer against a fake registry, removed-package warnings and refusal, `self-update` with a signed fake release (through the GitHub API, and through `/ot/latest` with no downgrade), the newer-ot note in `ot outdated` (daily cache, and never for dev builds, agents, CI or `OT_NO_UPDATE_CHECK=1`) |
| `cli/feedback_test.go` | `ot feedback`: message with `--kind`/`--about`, piped stdin with `--email`, bad kind exits 2 |
| `cli/machine_test.go` | `--json` detection, error codes, JSON errors on stderr, no prompts without a terminal, envelope provenance, `--all` JSON lines, stdout stays JSON |
| `cli/mcp_test.go` | `ot mcp`: tool list, passive runs, consent by elicitation and by token, policy and trust, unattended CLI runs need `--yes`, `mcp install`, docs and plugin match the server, policy changes without a restart, shutdown, sandbox mode, batches |
| `cli/keysetup_test.go` | `ot keys setup` at a terminal, refused without one, `key_setup` never shows values |
| `cli/token_test.go` | `ot token create|list|revoke` against a fake registry |
| `cli/info_test.go` | `ot info` prints a runnable command and the key hint |
| `cli/starter_test.go` | A fresh machine: `ot auto` offering the starter playbook's tools at a terminal (no, dry run, yes; deprecated tools left out), `not_installed` with the `ot playbook … --yes` hint without one, `ot playbook` asking, MCP `run_all` answering `not_installed` with `suggested_tools` |
| `cli/install_test.go` | `ot install` with one and several packages: hints, JSON shapes, a bad reference installing nothing, exit codes when installs fail, a missing engine stopping the rest; `playbook -y` installing in one go |
| `agent/agent_test.go` | `Classify`, `DecideRun`, policy lists and limits, loading, live policy changes, consent tokens, the audit log, `notifies_target` in descriptions |
| `specfiles/specfiles_test.go` | Copies equal `spec/`; the pivot map covers every entity type; every schema enum value has a description |
| `runner/textentities_test.go`, `runner/example_test.go` | Entities from text output; example commands |
| `cmd/mcpb/main_test.go` | MCP Bundle packing and `server.json` |
| `envelope/envelope_test.go` | `ParseOutput` per format; `Write` formats |
| `manifest/validate_test.go` | Every valid fixture passes, every invalid fixture's first code, tag mismatch, file checks, embedded schema equals `spec/schema/v1.json` |
| `manifest/seed_test.go` | Every `seed/*/*/otinstaller.yaml` validates with its files (at least 50) |
| `manifest/bundle_test.go` | `BundleFiles`: the manifest uploaded as `otinstaller.yaml`, images under the folder (skipping dot and build folders and images over 2 MB), only referenced images when over the limit, a missing README |
| `playbook/playbook_test.go` | Bundled playbooks, bundled tools exist in the seed (`TestBundledPlaybooksFitSeed`: each takes one of its playbook's input types and needs no key), later dirs win, parse errors, a broken file is an error |
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
