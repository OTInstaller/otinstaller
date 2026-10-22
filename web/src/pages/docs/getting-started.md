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

Archives for every platform, and deb and rpm packages, are on [GitHub Releases](https://github.com/OTInstaller/ot/releases),
with `checksums.txt` signed by the release key. Homebrew and Scoop packages are coming after the beta.

Later, `ot self-update` brings in new releases after checking their signature. Then check your machine:

```sh
ot doctor
```

`ot doctor` looks for Docker (or Podman, OrbStack or Colima), Python 3.10+ and pipx, and your OS keychain.

### No Docker? Install otlite

On Linux or macOS without a container runtime, [otlite](/docs/otlite) is the lightweight edition: it installs the
same kind of tools from pip or git into per-tool virtualenvs and runs them directly, with the same typed inputs and
`results/` layout.

```sh
curl -fsSL https://get.otinstaller.com/otlite | sh
```

The installer finds a supported Python, installs pipx if it is missing and installs otlite with it; with pipx
already there, `pipx install otlite` does the same.

Then `otlite init`, `otlite install sherlock` and `otlite run sherlock -- u:johndoe`. The rest of this page is about
`ot`; the [otlite page](/docs/otlite) has its own walkthrough.

## 2. Find a tool

```sh
ot search username
ot search --input email --no-keys
```

Every tool page on this site shows the same: what it takes, what it finds, whether it needs API keys, and whether it contacts the target.

## 3. Run it

```sh
ot run osintverse-community/dns-records d:example.com --format table
```

`d:` says the value is a domain (`e:` email, `u:` username, `p:` phone, `ip:`, `url:`); `--domain example.com` means the same. The first run installs the tool after asking once. Docker tools run in a container with no host files, no extra privileges and a memory limit; Python tools run inside the same kind of container when Docker is available.

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
ot guide read osintverse-community/email-investigation
ot guide tools osintverse-community/email-investigation
```
