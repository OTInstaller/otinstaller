---
layout: ../../layouts/Docs.astro
title: otlite, the no-Docker edition
description: Install and run OSINT tools on Linux and macOS without a container runtime. otlite installs pinned releases into per-tool virtualenvs.
---

`otlite` is the lightweight edition of OTInstaller for Linux and macOS machines without Docker. It installs tools from pip or
git, each into its own virtualenv under `~/.otlite`, runs them by name with the same typed inputs as `ot`, and saves
every run under `results/` with a `.meta.json` sidecar. It needs Python 3.10 or newer, git and `python3-venv`, and
nothing else. The [otlite page](/otlite) is the short version. It was called `otinstaller` until version 1.0; see [upgrading from otinstaller](#upgrading-from-otinstaller).

## Which edition?

| | `ot` | `otlite` |
| --- | --- | --- |
| Platforms | Linux, macOS, Windows | Linux, macOS |
| Needs | Docker Desktop, OrbStack, Colima or Podman (pipx tools can run `--native` without one) | git (the installer brings Python when there is none) |
| Where tools come from | The registry: signed, scanned, reviewed packages | A tested catalog bundled with each otlite release |
| How a tool runs | In a container with all capabilities dropped, no host files | Directly on your machine, in its own virtualenv |
| Tool arguments | Only the inputs the manifest declares | Anything after `--` goes to the tool |
| API keys | Your OS keychain (`ot keys set`) | `~/.otlite/.env`, mode 600 (`otlite keys set`) |
| Results | `results/<tool>/<target>/` plus a sidecar | The same layout and sidecar |

Use `ot` when you can: its packages are pinned by digest or hash, signed, scanned and reviewed, and run with no
access to your files. Use `otlite` on a server or VM without a container runtime, or when a tool needs raw
arguments or an interactive terminal. Both can share one `results/` folder.

## Install

```sh
curl -fsSL https://get.otinstaller.com/otlite | sh
```

It needs nothing installed first: with a Python 3.10+ and pipx on the machine it uses them, and otherwise it
downloads uv into `~/.local/bin` and installs otlite on a Python 3.12 that uv keeps in your home directory, without
sudo. Or, with pipx already installed, `pipx install otlite`.

`pip install otlite` inside a virtualenv works too. On Debian, Ubuntu and Kali a `.deb` is built by the CI from
[`otlite/debian`](https://github.com/OTInstaller/otinstaller/tree/main/otlite/debian). Then:

```sh
otlite doctor
otlite init
```

`doctor` checks Python, git and `venv`. `init` creates `~/.otlite` and shows the responsible-use notice once.

## Run a tool

```sh
otlite install sherlock
otlite run sherlock -- u:johndoe
otlite run --all u:johndoe
otlite auto johndoe@example.com
```

Typed inputs `u:` `e:` `p:` `d:` `url:` `q:` `geo:` `tg:` become each tool's own flags. Anything after `--` that is not
a typed input is passed to the tool as is. Every run's output is saved under `results/<tool>/<target>/` with a
`.meta.json` sidecar; `otlite results` lists them, filtered and sorted (`--tool`, `--since 7d`, `--sort duration`), and
`otlite extract` and `otlite diff` read them back. Each run also gets a `.envelope.json` in one shape for every tool (tool and version,
input, timing, exit code and the entities found), so scripts and agents read every tool the same way. `otlite list`, `search`, `info`, `update`,
`check-updates`, `remove`, `playbook`, `keys set`, `keys list`, `keys check` and `crash-reports` are the rest; `--json` and `--yes` work on all
of them. The full command reference is in the
[otlite README](https://github.com/OTInstaller/otinstaller/blob/main/otlite/README.md) and, for agents,
[llms.txt](https://github.com/OTInstaller/otinstaller/blob/main/otlite/llms.txt).

## Environment

| Variable | Meaning |
| --- | --- |
| `OTLITE_HOME` | Another home than `~/.otlite` |
| `OTLITE_RESULTS_DIR` | Save results there instead of `./results` |
| `OTLITE_REGISTRY` | Use another catalog file |
| `OTLITE_NO_BANNER` | No startup banner |
| `OTLITE_CRASH_REPORTS=off`, `DO_NOT_TRACK=1` | Never send crash reports (they are off unless you turn them on) |

The `OTINSTALLER_*` names are still read when the `OTLITE_*` one is unset.

## Upgrading from otinstaller

`pipx install otlite`, or `pip install -U otinstaller`, which now installs otlite and keeps an `otinstaller` command
that runs it. The first `otlite` command copies your API keys (`.env`) and settings from `~/.otinstaller` to
`~/.otlite`. Tools installed by otinstaller stay in `~/.otinstaller/tools`, because their virtualenvs hold absolute
paths: run `otlite install <tool>` for the ones you use, then remove the old folder. Results in `./results` need no
change. The full command map between `otinstaller`, `otlite` and `ot` is in the
[migration guide](https://github.com/OTInstaller/otinstaller/blob/main/docs/migrating-from-otinstaller.md).

## Releases and source

otlite lives in [`otlite/`](https://github.com/OTInstaller/otinstaller/tree/main/otlite) of the OTInstaller
repository, under the Apache License 2.0, and is released on [PyPI](https://pypi.org/project/otlite/) from tags
named `otlite-vX.Y.Z`. Its catalog is checked nightly; tools that stop installing or starting are fixed or dropped
in the next release. Bugs go to [GitHub issues](https://github.com/OTInstaller/otinstaller/issues).
