# OTInstaller agent plugin

Open-source OSINT tools for AI agents, with your consent. This plugin connects Claude Code or Cursor to
[OTInstaller](https://otinstaller.com) through `ot mcp`, the MCP server built into the `ot` command. It adds skills for
investigating, packaging tools and writing guides.

Tools run on **your machine**, each in a locked-down container. The agent asks you before any run that touches a
target, goes online or involves a person's identifiers, and every run is logged locally (`ot mcp audit`). Read
[AI agents and MCP](https://otinstaller.com/docs/agents) for the consent rules and the policy file.

## Install

1. Install `ot` v0.14.0 or later (`ot self-update` updates an older one): https://otinstaller.com/docs/getting-started.
   Docker (or Podman) must be running, and cosign must be installed for agents to install tools.
2. Add the plugin:

   - **Claude Code**

     ```bash
     claude plugin marketplace add OTInstaller/agent-plugin
     claude plugin install otinstaller@otinstaller
     ```

   - **Cursor:** run `ot mcp install cursor` for the MCP server, and copy `rules/otinstaller.mdc` into your project's
     `.cursor/rules/` for the rules. A Cursor marketplace listing is planned.
   - **Other clients:** `ot mcp install claude-desktop`, `vscode`, `codex` or `gemini`.

## What's inside

| Path | What it is |
| --- | --- |
| `.mcp.json`, `mcp.json` | Starts `ot mcp` (Claude Code, Cursor) |
| `skills/osint-investigation` | How to plan, ask for consent, run, read and report an investigation |
| `skills/publish-osint-tool` | Packaging a tool for the registry |
| `skills/write-osint-guide` | Writing and releasing a guide |
| `rules/otinstaller.mdc` | The same rules for Cursor |
| `hooks/hooks.json` | Warns at session start when `ot` is not on your PATH (Claude Code) |

The MCP server also has prompts that clients show as slash commands: `investigate_username`, `investigate_domain`,
`investigate_email`, `investigate_phone`, `pivot_from_run`, `compare_runs`, `write_playbook` and `publish_tool`.

## Recommended permissions (Claude Code)

Let the read-only tools run without asking, and keep asking for the rest. For example, in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__otinstaller__search_tools", "mcp__otinstaller__get_tool", "mcp__otinstaller__list_installed",
      "mcp__otinstaller__list_types", "mcp__otinstaller__suggest_pivots", "mcp__otinstaller__detect_type",
      "mcp__otinstaller__list_playbooks", "mcp__otinstaller__get_playbook", "mcp__otinstaller__list_runs",
      "mcp__otinstaller__get_run", "mcp__otinstaller__get_batch", "mcp__otinstaller__extract_indicators",
      "mcp__otinstaller__diff_runs", "mcp__otinstaller__search_guides", "mcp__otinstaller__read_guide",
      "mcp__otinstaller__validate_manifest", "mcp__otinstaller__doctor", "mcp__otinstaller__get_consent_status"
    ],
    "ask": ["mcp__otinstaller__run_tool", "mcp__otinstaller__run_all", "mcp__otinstaller__run_playbook",
      "mcp__otinstaller__install_tool", "mcp__otinstaller__uninstall_tool", "Bash(ot run:*)", "Bash(ot auto:*)",
      "Bash(ot playbook:*)"]
  }
}
```

## Use it lawfully

OTInstaller is for lawful investigation within its
[acceptable use policy](https://otinstaller.com/policy/acceptable-use). You are responsible for what you, and agents
working for you, run with it.

## Source

This repository is published from `integrations/agent-plugin/` in
[OTInstaller/otinstaller](https://github.com/OTInstaller/otinstaller); change it there. Licensed under the Apache
License 2.0.
