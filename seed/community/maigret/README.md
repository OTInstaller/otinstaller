# maigret (community package)

This repository packages [github.com/soxoj/maigret](https://github.com/soxoj/maigret) for the OTInstaller Registry as `osintverse-community/maigret`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/maigret`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

Maigret builds a dossier on a person from a username alone. It checks for accounts across the more than 3,000 sites in its database and, where a site exposes them, reads details about the account owner from the profile page or the site's API: names, locations, creation dates, bios and links to other accounts. It can also search again with the usernames and IDs it discovers.

Use it when you have a handle and want more than a list of sites: who the accounts say they are, where, and since when. A default run checks the 500 highest-ranked sites by traffic; `--top_sites` changes that number, and `--site` limits the run to one site.

This package runs Maigret with `--no-autoupdate`, so it uses the site database that shipped with this release instead of downloading a newer one.

## Run it

```
ot run osintverse-community/maigret u:johndoe
ot run osintverse-community/maigret u:johndoe --top_sites 1000
```

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install maigret
otlite run maigret -- u:johndoe
```

## What you get back

Plain text: a line for each account found, the details Maigret extracted beneath it, then a short report. The registry's scan of this release ran it for the username `github` on GitHub and recorded, among other lines:

```
[+] GitHub: https://github.com/github
 ├─uid: 9919
 ├─image: https://avatars.githubusercontent.com/u/9919?v=4
 ├─created_at: 2008-05-11T04:37:31Z
 ├─location: United States of America
 ├─follower_count: 91326
 ├─following_count: 0
 ├─fullname: GitHub
 ├─public_gists_count: 0
 ├─public_repos_count: 567
 ├─bio: How people build software.
 └─blog_url: https://github.com/about
[-] Extracted IDs: {}
[*] Short text report:
Search by username github returned 2 accounts.
Extended info extracted from 1 accounts.
```

`ot` saves the text and lists the URLs it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

No API key. It needs the network: every check is a request to the site in question, sent from your address. This package gives each site 20 seconds to answer and stops the whole run after 20 minutes.

The person behind the username isn't contacted, but what comes back is personal data. So `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take a username:

- [sherlock](https://otinstaller.com/osintverse-community/sherlock): finds accounts across 400+ sites and lists their addresses, without profile details.
- [social-analyzer](https://otinstaller.com/osintverse-community/social-analyzer): rates each profile it finds from 0 to 100.
- [naminter](https://otinstaller.com/osintverse-community/naminter): works through the WhatsMyName site list with browser-like requests.
- [mailcat](https://otinstaller.com/osintverse-community/mailcat): finds email addresses that exist for the same nickname at 25+ mail providers.

Packaged version: 0.6.7.
