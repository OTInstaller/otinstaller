# Agent directory and marketplace submissions (drafts)

Not submitted. Texts for listing the OTInstaller plugin and MCP servers. Each submission needs the owner's OK, and
the plugin and `ot mcp` should be tried in a real client first (launch checklist). The forms change, so fit these
texts to the fields each one asks for. The runbook is [../publishing-setup.md](../publishing-setup.md), section 12.

Already listed: the MCP Registry has `com.otinstaller/ot` (the local server, as `.mcpb` bundles) and
`com.otinstaller/registry` (the read-only remote server).

OSINT tools get extra scrutiny from reviewers. Lead with what keeps a person in control: consent before runs, the
local audit log, the sandbox and signed artifacts.

## Shared texts

**Name:** OTInstaller

**Short description** (under 100 characters):

> Install and run open-source OSINT tools in a local sandbox, asking before runs that touch a target.

**Long description:**

> OTInstaller is a free, open-source registry of OSINT tools and investigation guides. Its plugin connects your agent
> to `ot mcp`, the MCP server built into the `ot` command, so the agent can search the registry, read what each tool
> does, install signed tools and run them on your machine.
>
> Nothing runs on our servers. Each tool runs in a locked-down container: read-only, no capabilities, no network
> unless the tool declares it, and pinned to an image digest whose signature is checked. Before any run that goes
> online, contacts the target or involves a person's details, the agent has to ask you, naming the exact tool,
> target and the sites it connects to. Every run, install and uninstall an agent asks for is written to a local
> audit log (`ot mcp audit`), and a policy file lets you limit or switch off what agents can do.
>
> The plugin also adds skills for planning an investigation, packaging a tool for the registry and writing a guide.

**Example prompts:**

- "Which passive tools can check a domain's email security? Run them on example.com."
- "Investigate the username johndoe: plan first, and ask me before anything touches a target."
- "Compare the last two runs of checkdmarc on example.com and tell me what changed."
- "Package this repository as an OTInstaller tool and validate the manifest."

**Safety and data handling:**

- Runs happen on the user's machine. The user's targets, inputs and results never leave it. OTInstaller only counts
  installs: a daily total per version, with no IP address, user or token stored. `OT_NO_TELEMETRY=1` switches even
  that off.
- Consent: passive runs (offline, no target contact, no personal data) need none. Every other run asks, once per tool
  for networked runs, and per tool and target for runs that touch a target or involve a person. A client that can't
  ask gets a single-use token bound to that exact call.
- Agents can't set API keys, sign in, publish packages or install unsigned tools.
- Tool output is treated as untrusted data: control characters are stripped, values are capped and every result is
  labelled.
- Use is bound by the acceptable use policy: https://otinstaller.com/policy/acceptable-use

**Links:**

| Field | URL |
| --- | --- |
| Homepage and documentation | https://otinstaller.com/docs/agents |
| Repository | https://github.com/OTInstaller/agent-plugin |
| Support | https://github.com/OTInstaller/feedback/issues |
| Privacy policy | https://otinstaller.com/policy/privacy |
| Terms | https://otinstaller.com/policy/terms |
| Acceptable use | https://otinstaller.com/policy/acceptable-use |
| Icon | `icon.svg` in the plugin repository |

**Category:** Security (or Research, if Security isn't offered).

## Anthropic directory

- **Where:** https://claude.ai/directory/manage (needs a paid plan).
- **What:** the Claude Code plugin, from `OTInstaller/agent-plugin`. The form reads the name, icon and links from
  `.claude-plugin/plugin.json`.
- **Install line for the listing:** `claude plugin marketplace add OTInstaller/agent-plugin`, then
  `claude plugin install otinstaller@otinstaller`.
- **Requirement to state:** `ot` on the user's PATH and Docker (or Podman) running.
- **Before submitting:** run `claude plugin validate --strict` on a clone of the repository.

## Cursor marketplace

- **What:** the same repository. Cursor reads `.cursor-plugin/plugin.json`, `rules/`, `skills/` and `mcp.json`.
- **Review:** manual.
- **After it's listed:** update the plugin README, whose Cursor line says a listing is planned, and publish a new
  plugin version.

## Remote server as a custom connector

The read-only server at `https://api.otinstaller.com/mcp` needs no listing to work: people add it as a custom
connector in Claude or ChatGPT. If a connector directory opens to submissions, use the short description above with:

> Read-only: search tools and guides, see each tool's consent class and pivots. It can't run tools; for that, use
> `ot mcp` on your own machine.
