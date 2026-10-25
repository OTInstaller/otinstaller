# social-analyzer (community package)

This repository packages [github.com/qeeqbox/social-analyzer](https://github.com/qeeqbox/social-analyzer) for the OTInstaller Registry as `osintverse-community/social-analyzer`. The tool is the work of its authors, under the AGPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/social-analyzer`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

Social Analyzer finds a person's profiles across social media and other websites from a username. Its detection modules combine several techniques into a rating from 0 to 100 (No, Maybe, Yes), which its authors intend to give fewer false positives.

Use it when you want each match weighed rather than just listed, for example when investigating profiles tied to cyberbullying, cyber grooming, cyberstalking or spreading misinformation, the uses its authors name. To keep a run short, narrow it with `--top` (the N most popular sites) or `--websites` (sites whose address contains the words you give, space separated).

This wrapper runs the Python CLI from PyPI (0.45, the last PyPI release) in its fast mode and prints one JSON document of detected profiles. The site list ships inside the package, so it is as current as that release. With no `--top` or `--websites` it checks every site, which can take many minutes. The upstream web app, screenshots and metadata extraction aren't part of this package.

## Run it

```
ot run osintverse-community/social-analyzer u:johndoe --top 100
ot run osintverse-community/social-analyzer u:johndoe --websites "github gitlab"
```

## What you get back

One JSON document listing the profiles Social Analyzer detected (`--method find`). Each entry describes the page it found: its `title`, its text, the site's category (`type`) and more. The registry's scan of this release, for the username `github` on sites matching `github`, recorded an entry ending:

```
"title": "GitHub · GitHub", "type": "Computers Electronics and Technology > Programming and Developer Software"}]}
```

`ot` keeps the document under `raw` in its result.

## Keys and network

No API key. It needs the network: every check is a request to the site in question, sent from your address. This package stops a run after 30 minutes; a typical run takes about 5.

The person behind the username isn't contacted or notified, but what comes back is personal data. So `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take a username:

- [sherlock](https://otinstaller.com/osintverse-community/sherlock): finds accounts across 400+ sites and lists their addresses.
- [maigret](https://otinstaller.com/osintverse-community/maigret): reads profile details, such as names and locations, from the accounts it finds.
- [naminter](https://otinstaller.com/osintverse-community/naminter): works through the WhatsMyName site list with browser-like requests.
- [investigo](https://otinstaller.com/osintverse-community/investigo): checks which of hundreds of websites have an account with the username.

Packaged version: 0.45.1.
