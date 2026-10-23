# Recording and reporting

A finding is only as good as your ability to show where it came from. Record as you go, in a form someone else can
follow and check.

## What `ot` records for you

Every `ot run` saves the tool's raw output and a `.meta.json` file next to it, under `results/` (or the folder you set
with `--results-dir`). The record holds the run's `run_id`, the tool, its version and image digest, the inputs, the
time, and a SHA-256 hash of exactly what the tool printed. Add `--case <name>` to keep a case's runs together.

- `ot extract` pulls the emails, domains, IP addresses, URLs and other entities out of saved runs.
- `ot diff <tool> <target>` compares the two most recent runs of a tool on the same target.
- `ot pivot <run-id>` suggests the next tools for what a run found.

## Your findings log

Keep one line per finding, with:

| Field | Example |
| --- | --- |
| When | 2026-10-20 14:05 UTC |
| What | Forum account `example-handle` uses the same profile photo as the marketplace listing |
| Source | The URL, and an archived copy |
| How | `ot run` with its `run_id`, or the manual step you took |
| Grade | Confirmed, likely or unrelated, with one line on why |

Archive pages that matter as soon as you find them (the Wayback Machine, or a local copy with its hash), because
public pages change and disappear.

## The report

1. **The question** from your scope, in one sentence.
2. **The answer**, with how sure you are.
3. **The findings** that support it, each with its source and grade.
4. **What you could not establish**, and what would be needed to.
5. **The method**: the tools and versions, and anything you did by hand.

Cite runs by their `run_id` so a colleague can find the exact output. When the case closes, delete what you collected
and no longer need, and note that you did.
