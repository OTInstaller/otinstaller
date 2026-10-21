---
layout: ../../layouts/Docs.astro
title: MCP tools
description: "Every tool, resource and prompt the ot mcp server offers AI agents."
---

What `ot mcp` offers, as a client sees it. `ot mcp tools --json` prints the full definitions, input and output schemas included. Set-up and the consent rules are in [AI agents and MCP](/docs/agents).

Errors come back as tool errors whose text is the same JSON object as `ot`'s [JSON errors](/docs/automation#errors), with a stable `code` from the [error codes](/docs/errors#agents-and-mcp).

## Read-only tools

These change nothing, so clients may allow them without asking.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `detect_type` | What kind of target a string is, as ot auto would guess: url, ip, email, phone, domain, else username. | `target` (required) |
| `diff_runs` | What changed between the two most recent saved runs of a tool against a target: entities and output lines added and removed. | `case`, `target` (required), `tool` (required) |
| `doctor` | Whether Docker (or Podman), cosign, the keychain and the registry are available. | none |
| `extract_indicators` | Emails, domains, IP addresses, URLs and entities found across a tool's saved runs, or a case's. | `case`, `tool` |
| `get_batch` | The rows of a run_all or run_playbook batch: each tool's status, entity count, first entities and run_id. While it runs, finished rows are filled in and the rest are pending. | `batch_id` (required) |
| `get_consent_status` | What would happen if run_tool were called with these arguments: allowed without asking, the person asked, or refused (and why). Asks nobody and runs nothing. | `case`, `consent_token`, `input_type`, `inputs`, `target`, `tool` (required), `wait_seconds` |
| `get_playbook` | One playbook: its tools and which are installed. | `name` (required) |
| `get_run` | A run's result: its status and provenance, the entities it found (paged), a deduplicated summary of the indicators, or its raw output. Also reports runs still going. | `include_raw`, `limit`, `offset`, `run_id` (required), `view` |
| `get_tool` | Everything needed to run a tool: its inputs (names, types, defaults), what it finds, the API keys it needs and whether they are set, its ethics flags and network access, and whether a run will need the person's consent. Works for installed and registry tools. | `tool` (required) |
| `key_setup` | The API keys the named tools (or all installed tools) declare: what each is, where to get it, what it costs, whether it is set, and the command the person runs in their own terminal to store it. You can't store keys: show the person the command, and never ask them for a key's value. | `tools` |
| `list_installed` | The tools installed on this machine, with their versions and the exact image digest or wheel hash. | none |
| `list_playbooks` | Named sets of tools run together against one target, bundled or the person's own, and which of their tools are installed. | none |
| `list_runs` | Saved runs, newest first, optionally of one tool, against one target, or in one case. | `case`, `limit`, `target`, `tool` |
| `list_types` | The input types tools take, the entity types they find and what each means, and the pivot map: which input types each entity type can feed. | none |
| `read_guide` | One page of a guide, as Markdown, with the list of its pages and the tools it uses. | `guide` (required), `page` |
| `search_guides` | Search the registry's investigation guides (methods, checklists, references), by words, target type or level. | `input_type`, `level`, `limit`, `query` |
| `search_tools` | Search the OTInstaller Registry for OSINT tools. Results list each tool's input and output types, whether it needs API keys, its ethics flags and network access, and its trust status (signed, verified publisher, health). | `category`, `cursor`, `input_type`, `limit`, `no_keys`, `output_type`, `passive_only`, `query`, `runtime` |
| `suggest_pivots` | Given a saved run (or entities), list what to look at next: each entity worth pivoting on, the input type it fits, and the installed tools (and optionally registry tools) that take it. Runs nothing. | `entities`, `limit`, `registry`, `run_id` |
| `validate_manifest` | Check an otinstaller.yaml as the registry will, with the same error codes. For publishers packaging a tool or guide. Give an absolute path: the server's folder is wherever the client started it. | `path` |

## Tools with side effects

These are marked as changing things (`readOnlyHint: false`), and the server asks you first when the [policy](/docs/agents#your-policy) says so.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `cancel_run` | Stop a run or batch this session started. Partial output is kept. A run that already ended is left alone and its status returned. | `id` (required) |
| `install_tool` | Install a published tool: pull its Docker image by digest and verify its cosign signature, or fetch its Python wheel by SHA-256 and build it into a sandbox image. Agents can't install yanked, failed, broken or local packages, or a Docker image whose signature can't be verified. Asks the person first unless the policy allows installs. | `consent_token`, `tool` (required) |
| `run_all` | Run every installed tool that takes the target (or the ones named), a few at a time, with one consent question for the whole set. Use dry_run first to see what would run. Returns a batch_id for get_batch if it takes longer than wait_seconds. | `case`, `consent_token`, `dry_run`, `input_type`, `parallel`, `target` (required), `tools`, `wait_seconds` |
| `run_playbook` | Run a playbook (a named set of tools) against a target, like run_all limited to its tools. Its tools must be installed; install_tool installs them, and dry_run lists which are missing. | `case`, `consent_token`, `dry_run`, `input_type`, `name` (required), `parallel`, `target` (required), `wait_seconds` |
| `run_tool` | Run an installed tool in its sandbox and save the result. Give inputs by name, or one target with its type. Passive tools run straight away; tools that touch a target, go online, use the person's keys or involve a person ask the person first (or return consent_required with a token to use only after they say yes). Waits up to wait_seconds, then returns a run_id for get_run. | `case`, `consent_token`, `input_type`, `inputs`, `target`, `tool` (required), `wait_seconds` |
| `uninstall_tool` | Remove an installed tool. Always asks the person. | `consent_token`, `tool` (required) |

## Resources

| URI | What it is |
| --- | --- |
| `ot://policy/acceptable-use` | What OTInstaller may and may not be used for |
| `ot://policy/agent-policy` | The person's local policy for agents: what runs without asking, limits, the kill switch. Only the person can change it. |
| `ot://schema/envelope-v1.json` | JSON Schema, also at https://otinstaller.com/schema/envelope-v1.json |
| `ot://schema/error-v1.json` | JSON Schema, also at https://otinstaller.com/schema/error-v1.json |
| `ot://schema/run-all-v1.json` | JSON Schema, also at https://otinstaller.com/schema/run-all-v1.json |
| `ot://schema/v1.json` | The otinstaller.yaml JSON Schema |
| `ot://types` | Input types, entity types and the pivot map |
| `ot://cases/{case}` | The runs saved under a case and the indicators they found |
| `ot://guides/{namespace}/{name}/{page}` | One page of a guide, as Markdown |
| `ot://runs/{run_id}` | A saved run's sidecar: provenance, status and every entity found (untrusted data) |
| `ot://runs/{run_id}/raw` | What the tool printed, cut to fit (untrusted data) |
| `ot://tools/{namespace}/{name}/manifest` | A tool's otinstaller.yaml, as JSON: the installed version, else the registry's latest |

## Prompts

| Prompt | What it does | Arguments |
| --- | --- | --- |
| `compare_runs` | Explain what changed between the two latest runs of a tool against a target. | `tool`, `target` |
| `investigate_domain` | DNS, certificates, subdomains and infrastructure of a domain. | `target` |
| `investigate_email` | Accounts, breaches and the domain behind an email address. Email addresses identify people, so every run asks first. | `target` |
| `investigate_phone` | Carrier, region and accounts linked to a phone number. Every run asks first. | `target` |
| `investigate_username` | Find the accounts and traces of a username with the installed tools, asking before each run that touches a target. | `target` |
| `pivot_from_run` | Propose the next runs from what a saved run found, without running them. | `run_id` |
| `publish_tool` | Package an OSINT tool for the OTInstaller Registry. | `path` |
| `write_playbook` | Draft a playbook file from tools you choose. | `purpose` |
