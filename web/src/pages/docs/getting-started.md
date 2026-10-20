---
layout: ../../layouts/Docs.astro
title: Getting started
description: Install the ot command and run an OSINT tool from the registry.
---

## 1. Install ot

`ot` is a single program for Windows, macOS and Linux. The installer downloads the release for your machine, checks its SHA-256 and the release signature, and puts it on your PATH.

macOS and Linux:

```sh
curl -fsSL https://get.otinstaller.com/ot | sh
```

Windows (PowerShell):

```powershell
irm https://get.otinstaller.com/ot.ps1 | iex
```

Package managers and other ways:

| How | Command |
| --- | --- |
| Homebrew | `brew install --cask otinstaller/tap/ot` |
| Scoop | `scoop bucket add otinstaller https://github.com/otinstaller/scoop-bucket` then `scoop install ot` |
| deb, rpm, archives | [GitHub Releases](https://github.com/otinstaller/ot/releases) |
| From source | `go install github.com/otinstaller/otinstaller/cli/cmd/ot@latest` (Go 1.25 or newer) |

Later, `ot self-update` brings in new releases after checking their signature. Then check your machine:

```sh
ot doctor
```

`ot doctor` looks for Docker (or Podman, OrbStack or Colima), Python 3.10+ and pipx, and your OS keychain.

## 2. Find a tool

```sh
ot search username
ot search --input email --no-keys
```

Every tool page on this site shows the same: what it takes, what it finds, whether it needs API keys, and whether it contacts the target.

## 3. Run it

```sh
ot run dheeraj/holehe-lite --email someone@example.com
```

The first run installs the tool after asking once. Docker tools run in a container with no host files, no extra privileges and a memory limit; Python tools run inside the same kind of container when Docker is available.

Results come back as a JSON result envelope that other tools and OSINTverse cases can read. Use `--format table` to read them in the terminal, and `-o results.json` to save them.

## 4. API keys

Some tools need a key for a paid or rate-limited service. `ot` says which key and where to get it, and keeps it in your OS keychain:

```sh
ot keys set HIBP_API_KEY
```

## 5. Guides

Guides are step-by-step investigation playbooks that use registry tools:

```sh
ot guide search email
ot guide read dheeraj/email-investigation-playbook
ot guide tools dheeraj/email-investigation-playbook
```
