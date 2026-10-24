# ot

`ot` is the OSINT package manager. One command installs, runs, updates or removes any tool in the
[OTInstaller registry](https://otinstaller.com), the largest registry built only for OSINT tools (over 130 of them).
No more cloning repositories, fixing Python versions and learning each tool's flags: every tool takes the same typed
inputs, runs in a container that can't read your files, and saves its result in the same JSON shape.

Put `ot` (or `ot.exe`) somewhere on your PATH, then check your machine:

```sh
ot doctor
```

Find and run a tool:

```sh
ot search email
ot run osintverse-community/holehe e:someone@example.com
ot runs     # every run is saved under ./results; `ot runs <run-id>` shows one
```

Or let `ot` pick: `ot auto someone@example.com` runs every installed tool that takes an email address, and on a fresh
machine offers to install a bundled playbook's tools first. `ot playbook --list` shows the playbooks.

For scripts, CI and AI agents: `--json` (or `OT_OUTPUT=json`) gives JSON output and one-line JSON errors on stderr, and
`ot` never prompts without a terminal. See https://otinstaller.com/docs/automation.

For AI agents (Claude, Cursor, Codex, VS Code, ...): `ot mcp install claude` (or `cursor`, `codex`, ...) adds ot's MCP
server to your client. Agents ask you before any run that touches a target. See https://otinstaller.com/docs/agents.

Docs: https://otinstaller.com/docs/getting-started · CLI reference: https://otinstaller.com/docs/cli ·
Bugs and ideas: https://github.com/OTInstaller/feedback/issues

`ot self-update` installs new releases after checking their signature; `ot outdated` says when one is out. Licensed under the Apache License 2.0
(LICENSE).
