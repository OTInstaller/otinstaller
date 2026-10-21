# Migrating from otinstaller to ot

`otinstaller`, the Python package manager (in [`python/`](../python)), is in maintenance: **security fixes only until
30 June 2027, then end of life**. Its replacement is `ot`, the registry CLI in [`cli/`](../cli). This guide maps every
`otinstaller` command to `ot`, says what has no equivalent yet, and lists what changes underneath.

## What changes underneath

| | otinstaller | ot |
| --- | --- | --- |
| Platforms | Linux only | Linux, macOS, Windows |
| Install from | apt (Debian/Kali), PyPI, pipx | Release binaries, Homebrew, Scoop; `ot self-update` |
| Where tools come from | A catalog bundled in each release | The registry, `https://api.otinstaller.com/v1` |
| How a tool runs | Directly on the host, in its own virtualenv | In a container (Docker or Podman) with all capabilities dropped, or `--native` for pipx packages |
| Trust | Pinned version, install and smoke test | Pinned image digest or wheel SHA-256, cosign signatures, security scans and review before publishing |
| Tool names | `sherlock` | `osintverse-community/sherlock` (namespace/name) |
| Home | `~/.otinstaller` (`OTINSTALLER_HOME`) | `~/.ot`, `%APPDATA%\ot` on Windows (`OT_HOME`) |
| API keys | `~/.otinstaller/.env` | The OS keychain (`ot keys set`), or an environment variable of the same name |
| Results | `./results/<tool>/<target>/` and a `.meta.json` sidecar | The same layout and sidecar fields; `OTINSTALLER_RESULTS_DIR` still works, `OT_RESULTS_DIR` is the new name |
| Tool arguments | Anything after `--` goes to the tool | Only the inputs the package's manifest declares (`--<input>` or a typed input) |

`ot` needs Docker Desktop, OrbStack, Colima or Podman for Docker packages and sandboxed pipx packages. Without one,
only pipx packages run, with `--native`.

## Commands

| otinstaller | ot | Notes |
| --- | --- | --- |
| `otinstaller init` | nothing to do | There is no global notice to accept: `ot info` and `ot install` show each tool's ethics flags. `ot init` is something else: it scaffolds a manifest for publishing your own tool |
| `otinstaller list` | `ot search <query>` | Filters: `--input username`, `--no-keys`, `--runtime`, `--kind tool` |
| `otinstaller list --installed` | `ot list` | |
| `otinstaller search <query>` | `ot search <query>` | Searches the whole registry, not a bundled list |
| `otinstaller info <tool>`, `otinstaller <tool>` | `ot info <namespace/name>` | Inputs, keys, ethics flags and trust status. A bare name is not accepted |
| `otinstaller install <tool>...` | `ot install <namespace/name>` | One package per command. `ot run` and `ot playbook --yes` also install missing tools |
| `otinstaller install --all` | none | Install the packages you need one by one |
| `otinstaller run <tool> -- u:johndoe` | `ot run <namespace/name> u:johndoe` | Typed inputs `u:` `e:` `d:` `p:` `url:` work the same, without `--`; `ot` adds `ip:` |
| `otinstaller run <tool> -- <raw args>` | `ot run <namespace/name> --<input> <value>` | Only declared inputs (`ot info` lists them). A flag the manifest doesn't expose can't be passed |
| `otinstaller run <tool1> <tool2> -- u:x` | `ot playbook <your playbook> u:x` | Or `ot run --all u:x` for every installed tool |
| `otinstaller run --all u:johndoe` | `ot run --all u:johndoe` | Runs every installed tool with an input of that type and skips the ones that can't run unattended |
| `otinstaller run ... -p 4` | `--parallel 4` | |
| `otinstaller run ... --case <name>` | `--case <name>` | Same `results/cases/<case>/` layout |
| `otinstaller run ... --output <dir>` | `--results-dir <dir>` | In `ot`, `-o` writes the result envelope to a file instead |
| `otinstaller run ... --live` | (always on) | `ot run --all`, playbooks and `ot auto` print a progress line as each tool finishes, then the summary. `--live` is accepted and does nothing |
| `otinstaller run ... --json` | `--format json` | `ot run` prints a result envelope (JSON by default; also `table`, `csv`, `raw`) |
| `otinstaller playbook --list` | `ot playbook --list` | |
| `otinstaller playbook <name> <target>` | `ot playbook <name> <target>` | A bare target gets its type guessed as in `ot auto`, or give the prefix (`d:example.com`). The same two playbooks are bundled. Your own need full package names; see [typed-inputs-and-results.md](typed-inputs-and-results.md#ot-playbook) |
| `otinstaller auto <target>` | `ot auto <target>` | Same guessing order (url, ip, email, domain, then username), plus phone numbers starting with `+`. `--type` and `--dry-run` work the same. `ot` doesn't ask for confirmation, and lists matching registry tools you haven't installed only through `ot search --input <type>` |
| `otinstaller example <tool>` | none | `ot info` shows the inputs and an example command |
| `otinstaller extract <tool or path>`, `--case` | `ot extract <tool or path>`, `--case` | Emails, domains, IPs and URLs from every saved output (not only `.txt`), plus the entities in the sidecars, grouped by type |
| `otinstaller diff <tool> <target>`, `--case` | `ot diff <tool> <target>`, `--case` | Compares the two most recent runs' lines and entities. Line order is ignored, so a tool that lists results in a new order shows no change |
| `otinstaller check-updates` | `ot outdated` | Installed and latest version of each package, and whether it was removed from the registry |
| `otinstaller update <tool>`, `--all` | `ot update <namespace/name>`, `--all` | Installs the latest published version, with the same signature and trust checks as `ot install`. `ot install <namespace/name>@<version>` pins one |
| `otinstaller remove <tool>` | `ot uninstall <namespace/name>` | |
| `otinstaller remove --all` | none | Uninstall one by one |
| `otinstaller keys check` | `ot keys list`, `ot doctor` | `ot keys set NAME` stores a key (value from stdin); `ot run` names a missing required key and exits 3 |
| `otinstaller resume` | none | An interrupted `ot run` keeps its partial output and a sidecar with status `interrupted`; run it again. An install is recorded only once it has finished |
| `otinstaller doctor` | `ot doctor` | Checks Docker or Podman, pipx, Python, the keychain and the registry |
| `otinstaller crash-reports` | none | `ot` sends no crash reports. `OT_NO_TELEMETRY=1` turns off its anonymous install counts |
| `otinstaller about`, `--version` | `ot --version` | `ot self-update` updates it |

## Exit codes

otinstaller returned 1 (error), 2 (invalid input), 130 (interrupted) and, for a single run, the tool's own exit code.
`ot` returns 0 success, 1 tool error (the tool's own code is in the envelope and the sidecar), 2 bad usage, 3 missing
key, 4 trust refusal, 5 runtime missing, 124 timeout and 130 interrupted.

## Moving your setup

- **API keys.** For each line in `~/.otinstaller/.env`, run `ot keys set NAME` and paste the value, or export it where
  you run `ot`. `ot info` lists the key names a package reads.
- **Results.** Nothing to move: `ot` writes the same layout and reads `OTINSTALLER_RESULTS_DIR` if it is set. Old and
  new runs can share a folder.
- **Playbooks.** Copy `./playbooks/*.yaml` and change each tool name to its package name from the table below.
- **Scripts.** Replace `otinstaller run <tool> -- <typed inputs>` with `ot run <namespace/name> <typed inputs>`. Tools
  that took raw arguments need `--<input>` flags (`ot info` lists them).
- **Removing otinstaller.** `otinstaller remove --all`, then `pipx uninstall otinstaller` or
  `sudo apt remove otinstaller`, and `rm -rf ~/.otinstaller` once your keys are moved.

## Tools

otinstaller's 47 tools and their registry packages. A package can be installed once it is published: they are prepared
in [`seed/`](../seed) and go through the normal review first. "Input" is the typed input for its main input; `ot info`
lists the rest.

| otinstaller | ot package | Input, or why there is none |
| --- | --- | --- |
| `maigret` | `osintverse-community/maigret` | u: |
| `ghunt` | none | not packaged: needs a Google login before it can do anything |
| `theharvester` | `osintverse-community/theharvester` | d: |
| `spiderfoot` | none | not packaged: a passive scan runs for more than an hour, past ot's longest timeout |
| `instaloader` | none | not packaged: Instagram blocks anonymous requests from cloud servers, so its health check can't pass |
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

Tools that are not packaged keep working in `otinstaller` until its end of life. Their maintainers can publish them
(`ot import <repository>`), which also lifts the license limits on community wrappers.

## The deprecation date

30 June 2027 is about six months after `ot` reaches feature parity. The gaps that blocked parity (`auto`, `--live`,
`extract`, `diff`, `check-updates` and `update`) are closed in `ot` and ship in its next release; the date leaves room
for that release, then six months. Six months covers two Kali releases and a Debian and Ubuntu point-release cycle, so
people who install from apt see the notice for a while before support ends. If that release slips, the date moves with
it, and this guide, the Python package's README and its notice change too.

What stays different on purpose: `ot` passes only the inputs a manifest declares (no raw arguments after `--`), installs
and removes one package at a time, has no `resume` (installs are recorded only when they finish, and an interrupted run
keeps its output), sends no crash reports, and doesn't package tools that need a login, a terminal or free-form
arguments.
