# Typed inputs, saved results, `ot run --all`, playbooks, `ot auto`, `extract` and `diff`

The Python package manager (`otinstaller`, now in maintenance) had three run features `ot` lacked: typed inputs
(`u:johndoe`), results saved to disk with a sidecar, and `run --all`. This note says how they map onto the manifest and
the result envelope, so `otinstaller` users lose nothing when they switch.

## Typed inputs

A typed input is a positional argument `<prefix>:<value>` after the package:

| Prefix | Manifest input type |
| ------ | ------------------- |
| `u:`   | `username`          |
| `d:`   | `domain`            |
| `e:`   | `email`             |
| `p:`   | `phone`             |
| `ip:`  | `ip`                |
| `url:` | `url`               |

Manifests already declare a `type` for every input, so no manifest change is needed: `u:johndoe` is assigned to the
input whose `type` is `username`. It is a shorthand for `--<that input's name> johndoe` and goes through the same
`ResolveInputs` checks (an `e:` value must still be an email address).

- No input of that type: usage error (exit 2) naming the inputs the tool has.
- Several inputs of that type: usage error asking for `--<name>`, since ot can't know which one is meant.
- The same input given both ways (`u:x --username y`) or the same prefix twice: usage error.
- Only arguments after the package are read as typed inputs, so a Windows path such as `D:\tools\otinstaller.yaml`
  is still a package. With `--all` there is no package and every positional is a typed input.

Python also had `q:`, `geo:`, `tg:`, `lat:` and `lng:`. The manifest has no matching input types, so they are left out;
those inputs are passed with `--<name>`.

## Saved results

Every `ot run` saves what the tool printed, unless `--no-save` is given:

```
<results>/<name>/<target>/<YYYYmmdd-HHMMSS>_<name>_<target>_<runid>.<ext>
<results>/<name>/<target>/<YYYYmmdd-HHMMSS>_<name>_<target>_<runid>.meta.json
<results>/<name>/<target>/<YYYYmmdd-HHMMSS>_<name>_<target>_<runid>.stderr.txt   (only when the tool wrote to stderr)
```

With `--case NAME` the tree sits under `<results>/cases/<case>/`.

- `<results>` is `--results-dir`, else `$OT_RESULTS_DIR`, else `$OTINSTALLER_RESULTS_DIR` (so existing setups keep
  working), else `./results`.
- `<name>` is the package name without its namespace (`osintverse-community/sherlock` → `sherlock`), as in Python. The
  full reference is in the sidecar.
- `<target>` is the typed input's value; without one, the first input (in manifest order) the user gave; without one,
  `target`. Components are sanitized with Python's rules: lowercased, anything outside `[a-z0-9._-]` becomes `_`, runs
  of `_` collapse, leading and trailing `_ . -` are stripped, at most 80 characters.
- The timestamp is UTC; `<runid>` is 8 random hex characters.
- `<ext>` follows `runtime.output_format`: `json`, `jsonl`, `csv` or `txt`.

### Raw output, not the envelope

The saved file holds the tool's stdout byte for byte, streamed to disk while it runs, so the SHA-256 in the sidecar
covers exactly what the tool produced and a timeout or Ctrl-C still leaves the partial output. The envelope ot prints
is derived from those bytes (`raw` re-encodes them); it is still printed on stdout as before, and `-o` still writes it
to a file. The sidecar carries the envelope's structured parts, so a saved run can be read without re-parsing.

### The `.meta.json` sidecar

Python's fields, with the same names and meaning, plus the envelope's:

```json
{
  "command": ["holehe", "--json", "--timeout", "10", "a@b.com"],
  "tool": "holehe-lite",
  "ref": "dheeraj/holehe-lite",
  "tool_version": "1.2.0",
  "runtime": "docker",
  "target": "a@b.com",
  "case": null,
  "input": {"email": "a@b.com", "timeout": "10"},
  "started_at": "2026-10-20T14:30:00Z",
  "ended_at": "2026-10-20T14:30:05Z",
  "duration_seconds": 5.2,
  "exit_code": 0,
  "status": "complete",
  "output_path": "results/holehe-lite/a_b.com/20261020-143000_holehe-lite_a_b.com_a1b2c3d4.json",
  "sha256": "3b1c…",
  "bytes": 12345,
  "envelope": 1,
  "entities": [{"type": "account", "value": "github.com/abc"}],
  "warnings": []
}
```

- `command` is the manifest command after substitution, as run inside the container (or by pipx). Secrets are passed
  as environment variables and never appear in it, so nothing needs redacting.
- `status`: `complete` (exit 0), `failed` (non-zero exit), `timeout` or `interrupted`. For the last two `exit_code` is
  `-1` and there are no entities.
- `sha256` and `bytes` describe the output file.
- `run_id`, `ot_version`, `client` (`cli`, or `ci` when the `CI` variable is set) and `artifact` (`kind`, `ref` pinned
  by digest or wheel hash, `signer` when the signature was verified, `from_backup`) are the envelope's provenance
  fields, so a saved run says exactly what ran. They were added later; older sidecars don't have them.

A `ot run` that is saved prints `Saved <path>` on stderr, so stdout stays the envelope and pipes keep working.

## `ot run --all`

`ot run --all u:johndoe [e:…]` runs every installed tool (guides excluded) that has an input of at least one of the
given types, `--parallel` at a time (default 4). Like Python, it skips a tool rather than fail the batch when it can't
run unattended: another required input without a default, or a required key that is not set. Skipped tools are listed
with the reason.

Each run is saved as above (`--no-save` is refused, since the summary is the only other output). Tool stderr goes to
the `.stderr.txt` file instead of the terminal, where parallel runs would interleave. stdout gets a summary table (tool,
status, entities, saved file), or with `--format json` the same as a JSON array; each row also carries `run_id` and up
to 20 `top_entities`. `--format jsonl` streams instead: one row per line, skipped tools first and then each run as it
finishes, then a `{"summary": {...}}` line with counts by status and the exit code. The exit code is 0 when every run
completed and 1 otherwise. The shapes are in `spec/schema/run-all-v1.json`.

## `ot playbook`

A playbook is a named list of tools run together against the same typed inputs, like `otinstaller playbook`:

```
ot playbook --list
ot playbook domain-recon d:example.com
ot playbook username-investigation u:johndoe --parallel 2
```

It works like `ot run --all` restricted to the playbook's tools (same flags, summary, saving and exit codes), with two
differences: a listed tool with no input of the given types is shown as skipped rather than left out, and runs are
saved under the case `playbook-<name>` (or the playbook's `case:`, or `--case`). Tools that are not installed stop the
run with the `ot install` commands to fix it; `--yes` installs them first.

Two playbooks are bundled: `domain-recon` (`osintverse-community/dnstwist`, `osintverse-community/crtsh-subdomains`) and
`username-investigation` (`osintverse-community/sherlock`, `osintverse-community/maigret`), the same tools as
otinstaller's except `crtsh-subdomains`, which replaces otinstaller's `ctfr` (both read Certificate Transparency logs). Your own go in `<ot home>/playbooks/` or `./playbooks/` as `<name>.yaml` (`./playbooks` wins, then the
ot home, then the bundled ones):

```yaml
name: my-recon            # optional, defaults to the file name
description: "What it is for"
case: my-case             # optional, defaults to playbook-<name>
tools:
  - osintverse-community/dnstwist
  - osintverse-community/crtsh-subdomains
```

otinstaller playbooks list bare tool names (`sherlock`); `ot` needs the full package name and says which one to use.
`requires_target` is accepted and ignored, since `ot playbook` always takes typed inputs. otinstaller guessed the
target type from a bare target (`example.com`); `ot` needs the prefix (`d:example.com`).

## `ot auto`

`ot auto <target>` guesses the target's type and runs every installed tool that takes it, like `otinstaller auto`. The
guess, first match wins: `url` (starts with `http://` or `https://`), `ip` (IPv4 or IPv6), `email`, `phone` (starts with
`+`, 7 to 15 digits), `domain` (ends in an IANA top-level domain, from the same list otinstaller used), otherwise
`username`. `--type username` (or `email`, `domain`, `phone`, `ip`, `url`) skips the guess. Then it behaves like
`ot run --all` with that typed input. A prefixed target (`d:example.com`) is never second-guessed, and bare targets in
`ot playbook` are guessed the same way.

`--dry-run` (with `ot auto`, `ot run --all` or `ot playbook`) lists what would run and what would be skipped, and runs
nothing. While a batch runs, a line such as `[2/5] osintverse-community/sherlock complete` goes to stderr as each tool
finishes; otinstaller's `--live` is accepted and changes nothing.

## `ot extract` and `ot diff`

`ot extract <tool | path>` (or `--case <name>`) reads every saved output under the tool's results folder, a file or a
folder, and lists the emails, domains (IANA top-level domains only), IPv4 addresses and URLs in them, plus the entities
their sidecars hold, grouped by type. `--json` prints `{"emails":[],"domains":[],"ips":[],"urls":[],"entities":{}}`.

`ot diff <tool> <target>` (with `--case` for a case) compares the two most recent saved runs of a tool against a target:
lines and entities that appeared (`+`) or disappeared (`-`). Line order is ignored, since most tools list results in a
different order each run; repeated lines count. Runs are ordered by the timestamp in their file name, then by when their
output was written.

## `ot outdated` and `ot update`

`ot outdated` compares each installed package with the registry's latest version and changes nothing. `ot update
<namespace/name>...` or `ot update --all` installs the newer versions, through the same checks as `ot install`.
Packages installed from a local manifest show as "not in registry".
