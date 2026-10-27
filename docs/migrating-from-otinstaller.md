# Migrating from otinstaller: to otlite, and to ot

`otinstaller`, the Python package manager, is now **`otlite`** (in [`otlite/`](../otlite)), the no-Docker edition
of OTInstaller. It is supported, not deprecated: there is no end of life. The other edition is `ot`, the registry CLI
in [`cli/`](../cli), which installs signed, scanned packages and runs them in containers on Linux, macOS and Windows.

This guide has two parts. [Otinstaller to otlite](#otinstaller-to-otlite) is the rename: every command stays the same.
The rest maps `otlite` commands to `ot`, for when you want containers, the registry and more platforms, says what has
no equivalent, and lists what changes underneath.

## otinstaller to otlite

- **Install.** `pipx install otlite` (or `pip install -U otinstaller`: the old name on PyPI now depends on `otlite` and
  keeps an `otinstaller` command that runs it). On Debian and Kali the package is `otlite`, which replaces
  `otinstaller`.
- **Commands.** Identical. `otinstaller run sherlock -- u:johndoe` is `otlite run sherlock -- u:johndoe`.
- **Home.** `~/.otlite` instead of `~/.otinstaller`. The first `otlite` command copies `.env` (API keys),
  `accepted.json` and `crash_reports.json` across, and says so on stderr. Tools installed by `otinstaller` stay in
  `~/.otinstaller/tools`, because a virtualenv holds absolute paths and does not survive a move: run
  `otlite install <tool>` for the ones you use, then `rm -rf ~/.otinstaller`.
- **Environment variables.** `OTLITE_HOME`, `OTLITE_RESULTS_DIR`, `OTLITE_REGISTRY`, `OTLITE_NO_BANNER`,
  `OTLITE_CRASH_REPORTS`, `OTLITE_SENTRY_DSN`. The `OTINSTALLER_*` names are still read when the `OTLITE_*` one is
  unset, until otlite 2.0. `OTINSTALLER_NO_DEPRECATION_WARNING` is gone with the notice it hid.
- **Results.** Nothing changes: `./results/<tool>/<target>/` and the `.meta.json` sidecar are the same.
- **Scripts.** Replace the command name. Exit codes are unchanged (0, 1, 2, 130 and the tool's own).

## What changes underneath

| | otlite | ot |
| --- | --- | --- |
| Platforms | Linux and macOS | Linux, macOS, Windows |
| Install from | apt (Debian/Kali), PyPI, pipx | Release binaries, Homebrew, Scoop; `ot self-update` |
| Where tools come from | A catalog bundled in each release | The registry, `https://api.otinstaller.com/v1` |
| How a tool runs | Directly on the host, in its own virtualenv | In a container (Docker or Podman) with all capabilities dropped, or `--native` for pipx packages |
| Trust | Pinned version, install and smoke test | Pinned image digest or wheel SHA-256, cosign signatures, security scans and review before publishing |
| Tool names | `sherlock` | `osintverse-community/sherlock` (namespace/name) |
| Home | `~/.otlite` (`OTLITE_HOME`) | `~/.ot`, `%APPDATA%\ot` on Windows (`OT_HOME`) |
| API keys | `~/.otlite/.env` | The OS keychain (`ot keys set`), or an environment variable of the same name |
| Results | `./results/<tool>/<target>/` and a `.meta.json` sidecar | The same layout and sidecar fields; `ot` reads `OTINSTALLER_RESULTS_DIR` too; `OT_RESULTS_DIR` is its own name |
| Tool arguments | Anything after `--` goes to the tool | Only the inputs the package's manifest declares (`--<input>` or a typed input) |

`ot` needs Docker Desktop, OrbStack, Colima or Podman for Docker packages and sandboxed pipx packages. Without one,
only pipx packages run, with `--native`.

## otlite to ot: commands

| otlite | ot | Notes |
| --- | --- | --- |
| `otlite init` | nothing to do | There is no global notice to accept: `ot info` and `ot install` show each tool's ethics flags. `ot init` is something else: it scaffolds a manifest for publishing your own tool |
| `otlite start` | `ot start` | Both pick starter packs and tools from checkbox lists and install them. `ot start` also adds `ot`'s MCP server to AI clients and saves settings; its packs and tools are `namespace/name` packages from the registry (`--tools osintverse-community/sherlock`) |
| `otlite list` | `ot search <query>` | Filters: `--input username`, `--no-keys`, `--runtime`, `--kind tool` |
| `otlite list --installed` | `ot list` | |
| `otlite search <query>` | `ot search <query>` | Searches the whole registry, not a bundled list |
| `otlite info <tool>`, `otlite <tool>` | `ot info <namespace/name>` | Inputs, keys, ethics flags and trust status. A bare name is not accepted |
| `otlite install <tool>...` | `ot install <namespace/name>` | One package per command. `ot run` and `ot playbook --yes` also install missing tools |
| `otlite install --all` | none | Install the packages you need one by one |
| `otlite run <tool> -- u:johndoe` | `ot run <namespace/name> u:johndoe` | Typed inputs `u:` `e:` `d:` `p:` `url:` work the same, without `--`; `ot` adds `ip:` |
| `otlite run <tool> -- <raw args>` | `ot run <namespace/name> --<input> <value>` | Only declared inputs (`ot info` lists them). A flag the manifest doesn't expose can't be passed |
| `otlite run <tool1> <tool2> -- u:x` | `ot playbook <your playbook> u:x` | Or `ot run --all u:x` for every installed tool |
| `otlite run --all u:johndoe` | `ot run --all u:johndoe` | Runs every installed tool with an input of that type and skips the ones that can't run unattended |
| `otlite run ... -p 4` | `--parallel 4` | |
| `otlite run ... --case <name>` | `--case <name>` | Same `results/cases/<case>/` layout |
| `otlite run ... --output <dir>` | `--results-dir <dir>` | In `ot`, `-o` writes the result envelope to a file instead |
| `otlite run ... --live` | (always on) | `ot run --all`, playbooks and `ot auto` print a progress line as each tool finishes, then the summary. `--live` is accepted and does nothing |
| `otlite run ... --json` | `--format json` | `ot run` prints a result envelope (JSON by default; also `table`, `csv`, `raw`) |
| `otlite playbook --list` | `ot playbook --list` | |
| `otlite playbook <name> <target>` | `ot playbook <name> <target>` | A bare target gets its type guessed as in `ot auto`, or give the prefix (`d:example.com`). The same two playbooks are bundled. Your own need full package names; see [typed-inputs-and-results.md](typed-inputs-and-results.md#ot-playbook) |
| `otlite auto <target>` | `ot auto <target>` | Same guessing order (url, ip, email, domain, then username), plus phone numbers starting with `+`. `--type` and `--dry-run` work the same. `ot` doesn't ask for confirmation, and lists matching registry tools you haven't installed only through `ot search --input <type>` |
| `otlite example <tool>` | none | `ot info` shows the inputs and an example command |
| `otlite extract <tool or path>`, `--case` | `ot extract <tool or path>`, `--case` | Emails, domains, IPs and URLs from every saved output (not only `.txt`), plus the entities in the sidecars, grouped by type |
| `otlite diff <tool> <target>`, `--case` | `ot diff <tool> <target>`, `--case` | Compares the two most recent runs' lines and entities. Line order is ignored, so a tool that lists results in a new order shows no change |
| `otlite check-updates` | `ot outdated` | Installed and latest version of each package, and whether it was removed from the registry |
| `otlite update <tool>`, `--all` | `ot update <namespace/name>`, `--all` | Installs the latest published version, with the same signature and trust checks as `ot install`. `ot install <namespace/name>@<version>` pins one (holds it: `ot update --all` leaves it there) |
| `otlite remove <tool>` | `ot uninstall <namespace/name>` | |
| `otlite remove --all` | none | Uninstall one by one |
| `otlite keys check` | `ot keys list`, `ot doctor` | `ot keys set NAME` stores a key (value from stdin); `ot run` names a missing required key and exits 3 |
| `otlite resume` | none | An interrupted `ot run` keeps its partial output and a sidecar with status `interrupted`; run it again. An install is recorded only once it has finished |
| `otlite doctor` | `ot doctor` | Checks Docker or Podman, pipx, Python, the keychain and the registry |
| `otlite crash-reports` | none | `ot` sends no crash reports. `OT_NO_TELEMETRY=1` turns off its anonymous install counts |
| `otlite about`, `--version` | `ot --version` | `ot self-update` updates it |

## Exit codes

otlite returns 1 (error), 2 (invalid input), 130 (interrupted) and, for a single run, the tool's own exit code.
`ot` returns 0 success, 1 tool error (the tool's own code is in the envelope and the sidecar), 2 bad usage, 3 missing
key, 4 trust refusal, 5 runtime missing, 124 timeout and 130 interrupted.

## Moving your setup

- **API keys.** For each line in `~/.otlite/.env`, run `ot keys set NAME` and paste the value, or export it where
  you run `ot`. `ot info` lists the key names a package reads.
- **Results.** Nothing to move: `ot` writes the same layout and reads `OTINSTALLER_RESULTS_DIR` if it is set (not `OTLITE_RESULTS_DIR`). Old and
  new runs can share a folder.
- **Playbooks.** Copy `./playbooks/*.yaml` and change each tool name to its package name from the table below.
- **Scripts.** Replace `otlite run <tool> -- <typed inputs>` with `ot run <namespace/name> <typed inputs>`. Tools
  that took raw arguments need `--<input>` flags (`ot info` lists them).
- **Removing otlite.** `otlite remove --all`, then `pipx uninstall otlite` or `sudo apt remove otlite`, and
  `rm -rf ~/.otlite` once your keys are moved. Nothing forces this: both editions can stay installed.

## Tools

otlite's 47 tools and their registry packages. A package can be installed once it is published: they are prepared
in [`seed/`](../seed) and go through the normal review first. "Input" is the typed input for its main input; `ot info`
lists the rest.

| otlite | ot package | Input, or why there is none |
| --- | --- | --- |
| `maigret` | `osintverse-community/maigret` | u: |
| `ghunt` | none | not packaged: needs a Google login before it can do anything |
| `theharvester` | `osintverse-community/theharvester` | d: |
| `spiderfoot` | none | not packaged: a passive scan runs for more than an hour, past ot's longest timeout |
| `instaloader` | none | not packaged: Instagram blocks anonymous requests from cloud servers, so the scan's smoke test can't pass |
| `sherlock` | `osintverse-community/sherlock` | u: |
| `holehe` | `osintverse-community/holehe` | e: |
| `bbot` | none | not packaged: installs system packages with sudo when it runs, which ot's sandbox (no root) refuses |
| `dnstwist` | `osintverse-community/dnstwist` | d: |
| `h8mail` | none | not packaged: license NOASSERTION does not allow a community wrapper |
| `user-scanner` | none | not packaged: pip version '1.5.2.2' is not a plain dotted version |
| `torbot` | none | not packaged: license NOASSERTION does not allow a community wrapper |
| `toutatis` | none | not packaged: needs a login or config file first, which a wrapper can't provide |
| `ivre` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `aliens-eye` | `osintverse-community/aliens-eye` (packaged in `seed/`, not published yet) | u: |
| `paramspider` | `osintverse-community/paramspider` (packaged in `seed/`, not published yet) | d: |
| `nexfil` | `osintverse-community/nexfil` (packaged in `seed/`, not published yet) | u: |
| `yark` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `ignorant` | `osintverse-community/ignorant` | --country-code p: |
| `socialscan` | `osintverse-community/socialscan` | u: |
| `fsociety` | none | not packaged: prompts for input or runs until stopped; `ot run` has no terminal for that |
| `onionsearch` | `osintverse-community/onionsearch` (packaged in `seed/`, not published yet) | --query |
| `openosint` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `crosslinked` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `whatsapp-osint` | none | not packaged: needs a login or config file first, which a wrapper can't provide |
| `instagram-monitor` | none | not packaged: prompts for input or runs until stopped; `ot run` has no terminal for that |
| `mailaccess` | none | not packaged: writes into its own install folder at startup, which ot's read-only sandbox refuses |
| `secator` | none | not packaged: license NOASSERTION does not allow a community wrapper |
| `sublist3r` | `osintverse-community/sublist3r` (packaged in `seed/`, not published yet) | d: |
| `socid-extractor` | `osintverse-community/socid-extractor` (packaged in `seed/`, not published yet) | url: |
| `dnsgen` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `sitedorks` | none | not packaged: prompts for input or runs until stopped; `ot run` has no terminal for that |
| `linkook` | `osintverse-community/linkook` (packaged in `seed/`, not published yet) | u: |
| `osint-brazuca-regex` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `finalrecon` | `osintverse-community/finalrecon` (packaged in `seed/`, not published yet) | url: |
| `fierce` | `osintverse-community/fierce` (packaged in `seed/`, not published yet) | d: |
| `pywerview` | none | not packaged: declares no typed inputs, so there is nothing to map onto manifest inputs |
| `ctfr` | `osintverse-community/ctfr` (packaged in `seed/`, not published yet) | d: |
| `blackbird` | none | not packaged: its author removed its license in 2024, so it may not be redistributed |
| `telegram-phone-number-checker` | none | not packaged: needs a login or config file first, which a wrapper can't provide |
| `auto-archiver` | none | not packaged: needs a login or config file first, which a wrapper can't provide |
| `edgar-tool` | none | not packaged: writes its results only to a file, not to stdout |
| `instagram-location-search` | none | not packaged: drives Chrome through Selenium, which the wrapper image lacks |
| `telepathy` | none | not packaged: needs a login or config file first, which a wrapper can't provide |
| `neutrosint` | none | not packaged: ProtonMail's API rejects its requests, so it never returns a result |
| `zen` | none | not packaged: GitHub answers its requests with an HTML page, so it never returns a result |
| `thebigbrother` | `osintverse-community/thebigbrother` (packaged in `seed/`, not published yet) | u: |

Tools that are not packaged keep working in `otlite`. Their maintainers can publish them
(`ot import <repository>`), which also lifts the license limits on community wrappers.

## What stays different on purpose

`ot` passes only the inputs a manifest declares (no raw arguments after `--`), installs and removes one package at a
time, has no `resume` (installs are recorded only when they finish, and an interrupted run keeps its output), sends no
crash reports, and doesn't package tools that need a login, a terminal or free-form arguments. Those are the reasons
to keep `otlite` around, and why it is a supported edition rather than a transition.
