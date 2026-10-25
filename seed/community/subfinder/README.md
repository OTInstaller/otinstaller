# subfinder (community package)

This repository packages [github.com/projectdiscovery/subfinder](https://github.com/projectdiscovery/subfinder) for the OTInstaller Registry as `osintverse-community/subfinder`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/subfinder`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

## What it does and when to use it

subfinder is ProjectDiscovery's subdomain discovery tool. It returns the subdomains of a domain using passive online sources only: it asks services that already collect this data, and never queries the target's own servers. Its authors built it to do that one job, quickly.

Use it to map a domain's hosts before you look at any of them: during a security assessment of a domain you're allowed to test, when checking which names an organisation exposes, or as the first step before resolving or probing hosts with other tools.

## Run it

```
ot run osintverse-community/subfinder d:example.com
```

## What you get back

JSON lines, one object per subdomain found, naming the subdomain (`host`), the domain you asked about (`input`) and the source that reported it (`source`). The registry's scan of this release ran it for `otinstaller.com` and recorded:

```
{"host":"api.otinstaller.com","input":"otinstaller.com","source":"scanmalware"}
{"host":"www.otinstaller.com","input":"otinstaller.com","source":"scanmalware"}
```

This package runs subfinder with `-silent`, so nothing else is printed, and with `-duc`, so it doesn't check for a newer version of itself. `ot` keeps the parsed lines under `raw` in its result.

## Keys and network

No API key is needed. The upstream README notes that many of subfinder's sources need one; they are set in its `provider-config.yaml`, which this package doesn't supply, so a run here uses only the sources that work without a key.

It needs the network to reach the sources. The target's servers aren't contacted and the results aren't personal data, but as with any tool that uses the network, `ot mcp` asks before an agent runs it unless your policy allows networked runs, and a script without a terminal has to pass `--yes`. A run stops after 10 minutes.

## Alternatives

Other packages that take a domain:

- [findomain](https://otinstaller.com/osintverse-community/findomain): finds subdomains passively from certificate logs and public APIs.
- [subdominator](https://otinstaller.com/osintverse-community/subdominator): finds subdomains passively from about 70 public sources.
- [crtsh-subdomains](https://otinstaller.com/osintverse-community/crtsh-subdomains): finds subdomains in certificate transparency logs through crt.sh or Cert Spotter.
- [theharvester](https://otinstaller.com/osintverse-community/theharvester): gathers emails, IP addresses and hosts for a domain as well as subdomains.

Packaged version: 2.17.2.
