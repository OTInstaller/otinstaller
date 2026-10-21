---
layout: ../../layouts/Docs.astro
title: Manifest reference
description: Every field of otinstaller.yaml, the file that describes a tool or guide.
---

Every package has one `otinstaller.yaml` at its repository root. `ot init` writes a starting point and `ot validate` checks it the same way the registry does. The JSON Schema is at [/schema/v1.json](https://otinstaller.com/schema/v1.json), so editors can autocomplete it.

## A Docker tool

```yaml
schema: 1
name: holehe-lite
namespace: alice
version: 1.2.0
summary: Checks which sites an email address is registered on
readme: README.md
license: MIT
categories: [email, social-media]
inputs:
  - name: email
    type: email
    required: true
outputs:
  - type: account
runtime:
  kind: docker
  image: ghcr.io/alice/holehe-lite@sha256:3b1f…
  platforms: [linux/amd64, linux/arm64]
  command: ["holehe", "--json", "{email}"]
  output_format: json
ethics:
  touches_target: false
  auth_required: false
  collects_personal_data: true
test:
  input: { email: "test@example.com" }
```

A Python tool replaces `runtime` with `kind: pipx`, `package`, `package_version`, `entrypoint` and `wheel_sha256`.

## Fields

| Field | Required | Rules |
| --- | --- | --- |
| `schema` | Yes | `1` |
| `kind` | No | `tool` (default) or `guide` |
| `name` | Yes | 3–40 lowercase letters, digits and hyphens; unique in the namespace |
| `namespace` | Yes | The GitHub or GitLab owner of the repository |
| `version` | Yes | Semver, equal to the release tag without the `v` |
| `summary` | Yes | 10–140 characters |
| `readme` | Tools | Path to a Markdown file in the repository |
| `license` | Yes | An SPDX identifier; `NOASSERTION` is rejected |
| `categories` | Yes | 1–3 of: email, username, phone, domain-dns, ip-network, social-media, people, company, images-geo, crypto, breach-data, web-archive, documents-metadata, utilities |
| `tags` | No | Up to 10, lowercase and hyphenated |
| `inputs` | Tools | At least one; each has `name`, `type`, `required`; names are the `{placeholders}` in `command` |
| `inputs[].example` | No | A sample value of the input's type, shown in docs and to agents |
| `outputs` | Tools | At least one entity type |
| `outputs[].description`, `attrs` | No | What the entities are, and the attributes the tool sets on them: `name`, `type` (`string`, `number`, `boolean`, `url` or `datetime`), `description` |
| `runtime.kind` | Tools | `docker` or `pipx` |
| `runtime.image` | Docker | Pinned by digest (`@sha256:…`); the release workflow fills it in |
| `runtime.platforms` | Docker | Must include `linux/amd64` |
| `runtime.package`, `package_version`, `wheel_sha256` | pipx | The exact PyPI release and its wheel hash |
| `runtime.command` | Tools | An array (never a shell string); every `{placeholder}` must be an input |
| `runtime.output_format` | Tools | `json`, `jsonl`, `csv` or `text` |
| `runtime.timeout_seconds` | No | Default 300, at most 3600 |
| `runtime.typical_seconds` | No | How long a run usually takes; agents use it to decide how long to wait |
| `secrets` | No | API keys the tool reads from its environment: `name` (`UPPER_CASE`), `required`, `description`, `url`, and `pricing` (`free`, `free_tier` or `paid`) |
| `network` | No | `egress` and the `domains` it talks to (shown on the tool page). Tools run with no network unless `egress` is `true` |
| `ethics` | Tools | `touches_target`, `auth_required`, `collects_personal_data`: shown on the tool page. Optional: `notifies_target` (whether the target can see a run: a password-reset email, a login alert) and `notes` (a caveat of up to 280 characters, shown when `ot` asks for consent) |
| `test.input` | Recommended | Safe example values for the smoke test and nightly health checks |
| `docs` | No | `root` folder and `nav` list of Markdown pages for the tool's Docs tab |

The optional fields `inputs[].example`, `outputs[].description` and `attrs`, `runtime.typical_seconds`, `secrets[].pricing`, `ethics.notifies_target` and `ethics.notes` need `ot` v0.13.0 or later to validate. People with an older `ot` can still install tools that use them.

When a tool touches the target and doesn't set `notifies_target`, agents are told it may notify the target. Set it to `false` if it can't.

Guides use `title`, `level`, `format`, `content`, `related_tools` and `topics` instead of the tool fields; see [Guides and tool docs](/docs/guides).

## Input and output types

Inputs: `email`, `username`, `phone`, `domain`, `ip`, `url`, `name`, `image`, `crypto_address`, `hash`, `company`, and for plain parameters `string`, `integer`, `boolean` or `enum` (with `values`).

Outputs: `account`, `email`, `username`, `phone`, `domain`, `subdomain`, `ip`, `url`, `person`, `organization`, `location`, `breach`, `certificate`, `dns_record`, `image`, `document`, `crypto_address`, `transaction`, `other`.
