---
layout: ../../layouts/Docs.astro
title: Results and the envelope
description: The result envelope, saved runs, the .meta.json sidecar and how tools report entities.
---

Every `ot run` produces a **result envelope**: one JSON object that says what ran, with which inputs, what it found and
exactly what it printed. `ot run` prints it on stdout, and saves the tool's raw output with a `.meta.json` sidecar.
OSINTverse cases read the same envelope. The schema is [`/schema/envelope-v1.json`](/schema/envelope-v1.json).

## The envelope

```json
{
  "envelope": 1,
  "tool": "osintverse-community/whois-lookup@1.0.0",
  "runtime": "docker",
  "input": {"domain": "example.com"},
  "started_at": "2026-10-21T10:00:00Z",
  "ended_at": "2026-10-21T10:00:02Z",
  "duration_ms": 2140,
  "exit_code": 0,
  "entities": [
    {"type": "organization", "value": "Example Inc", "source": "rdap.org"},
    {"type": "email", "value": "abuse@example.com", "attrs": {"role": "abuse"}}
  ],
  "raw": {"...": "the tool's own output"},
  "warnings": [],
  "run_id": "a1b2c3d4",
  "ot_version": "1.4.0",
  "client": "cli",
  "artifact": {"kind": "image", "ref": "ghcr.io/osintverse-community/whois-lookup@sha256:…", "signer": "https://github.com/…"},
  "output": {"sha256": "…", "bytes": 5123, "path": "results/whois-lookup/example.com/….json", "meta_path": "….meta.json"}
}
```

| Field | Meaning |
| --- | --- |
| `envelope` | Always `1`. Fields are only added within version 1, so ignore keys you don't know. |
| `tool` | `namespace/name@version` |
| `input` | The resolved inputs, defaults included |
| `exit_code` | The tool's own exit code |
| `entities` | What the tool found, typed (below) |
| `raw` | The tool's output parsed by its `output_format`: JSON for `json`, an array for `jsonl`, an array of row objects for `csv`, a string for `text`. `null` when left out by `--max-raw`. |
| `warnings` | Problems reading the output, for example invalid JSON |
| `run_id` | Identifies the run; it is also part of the saved file names |
| `client` | `cli`, or `ci` when the `CI` environment variable is set |
| `artifact` | What exactly ran: the image pinned by digest (`kind: image`) or the wheel's SHA-256 (`kind: wheel`), the cosign identity it was verified against, and whether it came from the registry's backup copy |
| `output` | The SHA-256 and size of exactly what the tool printed, where it was saved, and `raw_omitted` |

## Entities

An entity is `{type, value}` plus optional `source` (the site or service it came from), `confidence` and `attrs` (any
further detail). `type` is normally one of the manifest's output types: `account`, `email`, `username`, `phone`,
`domain`, `subdomain`, `ip`, `url`, `person`, `organization`, `location`, `breach`, `certificate`, `dns_record`, `image`,
`document`, `crypto_address`, `transaction`, `other`.

Many entities can feed another tool: an `email` into a tool whose input type is `email`, a `subdomain` into a `domain`
input. `ot extract` collects them from saved runs, and `ot run --all e:<email>` runs everything that takes one.

### For tool authors

`ot` reads entities from your tool's output when it follows this convention; anything else stays in `raw`:

- with `output_format: json`, an object with an `entities` array:
  `{"entities": [{"type": "email", "value": "a@b.com"}], ...}`
- with `output_format: jsonl`, one entity per line (`{"type": "email", "value": "a@b.com"}`), or lines that each carry
  an `entities` array

Entities need a non-empty `type` and `value`. CSV and text output give no entities.

## Saved runs

Unless `--no-save` is given, each run is saved as it happens:

```
results/<tool>/<target>/<YYYYmmdd-HHMMSS>_<tool>_<target>_<run_id>.<json|jsonl|csv|txt>
results/<tool>/<target>/<YYYYmmdd-HHMMSS>_<tool>_<target>_<run_id>.meta.json
results/<tool>/<target>/<YYYYmmdd-HHMMSS>_<tool>_<target>_<run_id>.stderr.txt   (only when the tool wrote to stderr)
```

- `--results-dir` or `OT_RESULTS_DIR` moves `results/`. `--case NAME` saves under `results/cases/NAME/`.
- The output file is the tool's stdout byte for byte, so a timeout or Ctrl-C still leaves the partial output.
- The `.meta.json` sidecar holds:
  - the command as run (secrets are never in it)
  - `tool`, `ref` and `tool_version`
  - `target`, `case` and `input`
  - timing, `exit_code` and `status` (`complete`, `failed`, `timeout` or `interrupted`)
  - `output_path`, the `sha256` and size of the output file
  - the entities and warnings
  - the same provenance fields as the envelope: `run_id`, `ot_version`, `client` and `artifact`

`ot extract` and `ot diff` read saved runs. `ot diff <tool> <target>` compares the two most recent runs.

## Batches

`ot run --all`, `ot playbook` and `ot auto` print a summary instead of envelopes. Each row has the tool, its status, how
many entities it found, the first 20 of them (`top_entities`), its `run_id` and where it was saved. The full envelope
data is in each run's sidecar. With `-f jsonl` the rows stream as each tool finishes, followed by a summary line. The
schema is [`/schema/run-all-v1.json`](/schema/run-all-v1.json).
