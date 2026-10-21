---
layout: ../../layouts/Docs.astro
title: Quick start
description: Three commands from nothing to a result on your own machine.
---

You need **Docker Desktop** (or Podman) running. That is the only thing `ot` does not install for you: tools run in containers that cannot read your files.

## 1. Install ot

macOS and Linux:

```sh
curl -fsSL https://get.otinstaller.com/ot | sh
```

Windows (PowerShell):

```powershell
irm https://get.otinstaller.com/ot.ps1 | iex
```

The installer checks the download's SHA-256 and the release signature before it writes anything. Then:

```sh
ot doctor
```

It tells you whether Docker, cosign and your keychain are ready, and what to do if not.

## 2. Run a tool

```sh
ot run osintverse-community/dns-records d:example.com --format table
```

The first run asks once, installs the tool (its image is pulled by digest and its signature checked), runs it, and prints a table:

```
TYPE        VALUE                            SOURCE  CONFIDENCE
dns_record  A 172.66.147.243                 dns     high
dns_record  MX 0 .                           dns     high
dns_record  NS hera.ns.cloudflare.com.       dns     high
dns_record  TXT "v=spf1 -all"                dns     high
```

`d:` says the value is a domain. The other prefixes are `e:` email, `u:` username, `p:` phone, `ip:` and `url:`; `--domain example.com` works too. Without `--format table`, the result is JSON in the same shape for every tool, and every run is saved under `./results/`.

## 3. Find the next tool

```sh
ot search username
ot auto ada@example.com
```

`ot search` finds tools by what they take or by name. `ot auto` runs every installed tool that takes the value you give it. Each tool's page on this site shows its exact run command, what it finds, whether it needs an API key, and what to run next.

## When something is missing

- **A key:** `ot` names it and where to get one, then `ot keys set NAME` stores it in your OS keychain.
- **An input:** `ot` shows the exact command with an example value.
- **Docker:** `ot doctor` links to the install page.

Next: [Getting started](/docs/getting-started) for the longer tour, or [What you can do](/tour) for guides, playbooks and agents.
