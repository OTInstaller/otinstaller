# ot

`ot` installs and runs OSINT tools and investigation guides from the [OTInstaller Registry](https://otinstaller.com).

Put `ot` (or `ot.exe`) somewhere on your PATH, then check your machine:

```sh
ot doctor
```

Find and run a tool:

```sh
ot search email
ot run osintverse-community/holehe e:someone@example.com
```

For scripts, CI and AI agents: `--json` (or `OT_OUTPUT=json`) gives JSON output and one-line JSON errors on stderr, and
`ot` never prompts without a terminal. See https://otinstaller.com/docs/automation.

Docs: https://otinstaller.com/docs/getting-started · CLI reference: https://otinstaller.com/docs/cli ·
Bugs and ideas: https://github.com/OTInstaller/feedback/issues

`ot self-update` installs new releases after checking their signature. Licensed under the Apache License 2.0
(LICENSE).
