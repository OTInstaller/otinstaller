# phoneinfoga (community package)

This repository packages [github.com/sundowndev/phoneinfoga](https://github.com/sundowndev/phoneinfoga) for the OTInstaller Registry as `osintverse-community/phoneinfoga`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/phoneinfoga`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

## What it does and when to use it

PhoneInfoga is an information-gathering framework for phone numbers. It gathers basic information about an international number, such as its formats and country, then builds Google searches to find where the number appears: on sites such as whycall.me, locatefamily.com and spytox.com, and in documents and pages that mention it in any of its formats.

Use it when a phone number is your starting point and you want its standard formats and a ready-made set of searches. Its authors don't claim the data is relevant or verified, and are clear that it can't track a phone, find its precise location or break into it.

The upstream project describes itself as stable but unmaintained: bugs won't be fixed, and the repository could be archived at any time.

## Run it

Give the number in international format:

```
ot run osintverse-community/phoneinfoga p:+12025550123
```

## What you get back

Plain text, grouped by scanner. The registry's scan of this release ran it for `+12025550123`; the local scanner's part of the output was:

```
Results for local
Raw local: 2025550123
Local: (202) 555-0123
E164: +12025550123
International: 12025550123
Country: US
```

Before that come the Google search links, one `URL:` line each, in groups such as `General:`; opening them is up to you. The run ends with how many scanners succeeded (`2 scanner(s) succeeded` in the recorded run). `ot` saves the text and lists the URLs it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

The upstream README says its scanners must be configured for the tool to be effective. This package declares no keys and passes none, so only scanners that need no configuration run; in the recorded run, those were the local scanner and the Google search links.

It needs the network. Nobody is called or messaged, but the number and the results are personal data, so `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`. A run stops after 5 minutes.

## Alternatives

Other packages that take a phone number:

- [phone-parse](https://otinstaller.com/osintverse-community/phone-parse): parses a number offline for its validity, formats, country, original carrier, line type and time zones.
- [numint](https://otinstaller.com/osintverse-community/numint): looks up validity, line type, country, carrier and time zones, with optional risk scores from providers.
- [ignorant](https://otinstaller.com/osintverse-community/ignorant): checks whether a number is registered on Amazon, Instagram and Snapchat.

Packaged version: 2.11.2.
