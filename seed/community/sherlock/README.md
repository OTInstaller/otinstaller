# sherlock (community package)

This repository packages [github.com/sherlock-project/sherlock](https://github.com/sherlock-project/sherlock) for the OTInstaller Registry as `osintverse-community/sherlock`. The tool is the work of its authors, under the MIT license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/sherlock`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

Sherlock takes a username and checks whether an account with that name exists on more than 400 social networks and other websites. This package prints only the sites where it found one, each with the profile's address.

Use it early in an investigation, when all you have is a handle and you want to know where else it is in use. A match means a profile with that name exists, not that the same person owns it, so open each link and compare before you rely on it. To check one site only, pass `--site` with the site's name as Sherlock spells it, such as `GitHub`.

## Run it

```
ot run osintverse-community/sherlock u:johndoe
ot run osintverse-community/sherlock u:johndoe --site GitHub
```

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install sherlock
otlite run sherlock -- u:johndoe
```

## What you get back

Plain text, one line per site where the username was found. The registry's scan of this release ran it for the username `github` on GitHub alone and recorded:

```
[*] Checking username github on:

[+] GitHub: https://www.github.com/github

[*] Search completed with 1 results
```

`ot` saves the text and lists the profile URLs it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

No API key. It needs the network: every check is a request to the site in question, sent from your address. This package gives each site 20 seconds to answer and stops the whole run after 15 minutes.

The person behind the username isn't contacted, but what comes back is personal data. So `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take a username:

- [maigret](https://otinstaller.com/osintverse-community/maigret): checks more sites and reads profile details, such as names and locations, from the accounts it finds.
- [social-analyzer](https://otinstaller.com/osintverse-community/social-analyzer): rates each profile it finds from 0 to 100.
- [naminter](https://otinstaller.com/osintverse-community/naminter): works through the WhatsMyName site list with browser-like requests.
- [socialscan](https://otinstaller.com/osintverse-community/socialscan): checks a handful of major platforms through their sign-up servers, so reserved names count as taken.

Packaged version: 0.16.3.
