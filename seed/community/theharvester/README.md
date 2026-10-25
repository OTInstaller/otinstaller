# theharvester (community package)

This repository packages [github.com/laramies/theHarvester](https://github.com/laramies/theHarvester) for the OTInstaller Registry as `osintverse-community/theharvester`. The tool is the work of its authors, under the GPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/theharvester`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

## What it does and when to use it

theHarvester gathers names, emails, IP addresses, subdomains and URLs for a domain from public sources: search engines, certificate transparency logs, DNS datasets and threat-intelligence services. Its authors built it for the reconnaissance stage of a red team assessment or penetration test, to help determine a domain's external threat landscape.

Use it at the start of work on an organisation's domain, to collect the hosts and addresses that public sources already know about. By default this package queries seven sources that need no key: crtsh, certspotter, duckduckgo, hackertarget, otx, rapiddns and urlscan. Pass `--sources` with a comma-separated list to choose others. The command runs no DNS brute force and takes no screenshots, which are theHarvester's active modules.

## Run it

```
ot run osintverse-community/theharvester d:example.com
ot run osintverse-community/theharvester d:example.com --sources crtsh,certspotter
```

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install theharvester
otlite run theharvester -- d:example.com
```

## What you get back

Plain text. After a banner and the target, theHarvester says which sources it is searching, then lists what it found in sections for IPs, emails, people and hosts; an empty section says so, as in `[*] No emails found.` This package asks for at most 200 search results (`-l 200`).

`ot` saves the text and lists the emails, IP addresses and domains it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

No API key is needed for the default sources. Many of theHarvester's other sources need one, which it reads from its own `api-keys.yaml`. This package declares no keys, and each run creates a fresh default `api-keys.yaml` inside the container, so sources that need a key can't be used here.

It needs the network. The target's own servers aren't contacted, but every source you choose receives the domain. Emails and names in the results are personal data, so `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`. A run stops after 15 minutes.

## Alternatives

Other packages that take a domain:

- [subfinder](https://otinstaller.com/osintverse-community/subfinder): finds a domain's subdomains passively from dozens of public sources, as JSON lines.
- [crtsh-subdomains](https://otinstaller.com/osintverse-community/crtsh-subdomains): finds subdomains in certificate transparency logs through crt.sh or Cert Spotter.
- [hackertarget](https://otinstaller.com/osintverse-community/hackertarget): finds a domain's subdomains and DNS records through HackerTarget.
- [hunter-domain-search](https://otinstaller.com/osintverse-community/hunter-domain-search): lists the email addresses Hunter has found for a domain (needs a key).

Packaged version: 4.11.2.
