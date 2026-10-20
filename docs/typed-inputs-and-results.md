# Typed inputs, saved results and `ot run --all`

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

A `ot run` that is saved prints `Saved <path>` on stderr, so stdout stays the envelope and pipes keep working.

## `ot run --all`

`ot run --all u:johndoe [e:…]` runs every installed tool (guides excluded) that has an input of at least one of the
given types, `--parallel` at a time (default 4). Like Python, it skips a tool rather than fail the batch when it can't
run unattended: another required input without a default, or a required key that is not set. Skipped tools are listed
with the reason.

Each run is saved as above (`--no-save` is refused, since the summary is the only other output). Tool stderr goes to
the `.stderr.txt` file instead of the terminal, where parallel runs would interleave. stdout gets a summary table (tool,
status, entities, saved file), or with `--format json` the same as a JSON array. The exit code is 0 when every run
completed and 1 otherwise.
