# ot

`ot` is the OSINT package manager. One command installs, runs, updates or removes any tool in the
[OTInstaller registry](https://otinstaller.com), the largest registry built only for OSINT tools (over 130 of them).
No more cloning repositories, fixing Python versions and learning each tool's flags: every tool takes the same typed
inputs, runs in a container that can't read your files, and saves its result in the same JSON shape.

## Get started

Put `ot` (or `ot.exe`) somewhere on your PATH. Tools run in containers, so Docker Desktop or Podman must be running;
with `cosign` installed, `ot` also verifies each image's signature. Then set it up:

```sh
ot start      # pick starter packs and tools, AI agents and settings, then install
ot doctor     # check Docker, cosign, the keychain and the registry
```

`ot start` asks at a terminal; `ot start --tools <ns/name> --yes` does the same from a script, and
https://otinstaller.com/start builds the command for you.

## Run tools

```sh
ot search email                                        # tools that take an email address
ot run osintverse-community/holehe e:someone@example.com
ot runs                                                # every run is saved under ./results; `ot runs <run-id>` shows one
ot pivot <run-id>                                      # what to run next on what a run found
ot share <run-id>                                      # a link to the run's results that works for 24 hours
```

Typed inputs fill the matching input of any tool: `u:` username, `e:` email, `d:` domain, `p:` phone, `ip:` IP address
and `url:` URL. Or let `ot` pick: `ot auto someone@example.com` runs every installed tool that takes an email address,
and on a fresh machine offers to install a bundled playbook's tools first. `ot playbook --list` shows the playbooks.
Tools that need an API key say so; `ot keys setup` walks you through them, and keys stay in your OS keychain.

## Scripts, CI and AI agents

- `--json` (or `OT_OUTPUT=json`) gives JSON output and one-line JSON errors on stderr, and `ot` never prompts without a
  terminal. See https://otinstaller.com/docs/automation.
- `ot mcp install claude` (or `claude-desktop`, `cursor`, `vscode`, `codex`, `gemini`) adds ot's MCP server to your
  client. Agents ask you before any run that touches a target. See https://otinstaller.com/docs/agents.

## Updates

`ot outdated` lists installed tools with newer versions and `ot update --all` installs them. `ot self-update`
installs a new release of `ot` after checking its signature.

## Telemetry

`ot` counts installs and runs of registry packages, so the registry can show which tools are used and which versions
fail. A count carries the tool and its version, how a run ended and how long it took, the container engine, what
started it (a command, CI or an AI agent), and your OS, architecture and `ot` version. It never carries your inputs,
targets or results, file paths, run ids, case names, keys or tokens, and tools installed from a local manifest are
never counted. The registry keeps daily totals only.

```sh
ot telemetry                          # what is sent, and whether it is on
ot telemetry off                      # or set OT_NO_TELEMETRY=1 or DO_NOT_TRACK=1
OT_TELEMETRY_DEBUG=1 ot run <tool> …  # print each count instead of sending it
```

Turning it off also stops the offer to report a failed run; `DO_NOT_TRACK` stops the daily update check too. Details:
https://otinstaller.com/policy/privacy

## Links

Docs: https://otinstaller.com/docs/getting-started · CLI reference: https://otinstaller.com/docs/cli ·
Bugs and ideas: https://github.com/OTInstaller/feedback/issues · Source: https://github.com/OTInstaller/otinstaller

Licensed under the Apache License 2.0 (LICENSE).
