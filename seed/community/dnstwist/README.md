# dnstwist (community package)

This repository packages [github.com/elceef/dnstwist](https://github.com/elceef/dnstwist) for the OTInstaller Registry as `osintverse-community/dnstwist`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/dnstwist`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

dnstwist finds look-alike domains that could be used against a domain's users. It runs the domain through a variety of fuzzing algorithms, such as transposed letters, swapped vowels, homoglyphs and hyphenation, and checks which of the permutations are in use. That can detect typosquatters, phishing attacks, fraud and brand impersonation.

Use it to watch your own organisation's domains, or a brand you're investigating, for registrations that are one slip of the keyboard away. It usually generates thousands of permutations, and many more for a longer domain, each needing DNS lookups, so longer domains take longer.

This package runs it with `--registered`, so it reports only the permutations that are registered, as JSON. dnstwist's phishing-detection options (fuzzy hashes of web pages, screenshots) aren't used.

## Run it

```
ot run osintverse-community/dnstwist d:example.com
```

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install dnstwist
otlite run dnstwist -- d:example.com
```

## What you get back

A JSON array with one object per registered look-alike: the domain, the fuzzer that produced it and its DNS answers. One entry from the registry's scan of this release, for `example.com`:

```
    {
        "dns_a": [
            "192.64.151.235"
        ],
        "domain": "exampel.com",
        "fuzzer": "transposition"
    },
```

The package installs dnstwist without its optional extras, so the recorded run ended with `WARNING: DNS features are limited due to lack of DNSPython library`, and its entries carried A and AAAA records only. `ot` keeps the array under `raw` in its result.

## Keys and network

No API key. It needs the network for the DNS lookups, which go to your resolver; the upstream README asks that it can handle thousands of requests in a short time. The domain's owner isn't contacted, and the results aren't personal data. Even so, `ot mcp` asks before an agent runs it unless your policy allows networked runs, and a script without a terminal has to pass `--yes`. A run stops after 15 minutes.

## Alternatives

Other packages that take a domain:

- [ail-typo-squatting](https://otinstaller.com/osintverse-community/ail-typo-squatting): generates typo-squatting variants of a domain with 20+ permutation algorithms.
- [whois](https://otinstaller.com/osintverse-community/whois): looks up the WHOIS record of a look-alike you found.
- [urlscan-search](https://otinstaller.com/osintverse-community/urlscan-search): searches urlscan.io's existing scans of a domain, to see what a look-alike serves.

Packaged version: 20250130.0.1.
