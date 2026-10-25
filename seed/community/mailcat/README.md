# mailcat (community package)

This repository packages [github.com/sharsil/mailcat](https://github.com/sharsil/mailcat) for the OTInstaller Registry as `osintverse-community/mailcat`. The tool is the work of its authors, under the Apache-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/mailcat`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

mailcat finds existing email addresses for a nickname. Give it the part before the `@`, and it checks whether that name is taken at 26 mail providers covering more than 158 domains, among them Gmail, Outlook, Yahoo, Proton Mail, Yandex, Mail.ru, Zoho, Posteo and Fastmail. Depending on the provider, it checks over SMTP, through an API, the registration form or password recovery, or with a headless browser.

Use it when you have a username and want to know which email addresses it might have, for example to then check those addresses for registered accounts or breaches. An address that exists isn't proof that the same person owns it. Pass `--provider` to check a single provider, such as `gmail` or `proton`.

## Run it

```
ot run osintverse-community/mailcat u:johndoe
ot run osintverse-community/mailcat u:johndoe --provider proton
```

## What you get back

Plain text listing the addresses that exist for the nickname. The registry's scan of this release, for `example` at Proton, found none and printed nothing. `ot` saves the text and lists each email address in it as an entity in its result, marked low confidence because it was read from text.

## Keys and network

No API key. It needs the network: the checks go to each provider from your address.

The upstream README warns that the SMTP checks (Gmail, Yandex and mail.de) connect to the providers' mail servers on port 25, which most home internet providers and every major cloud provider block, so from those networks these checks time out. It suggests running mailcat through Tor or a proxy; this package has no input for either, so expect those three providers to time out unless your network allows outgoing port 25. The other checks work from any network. This package stops a run after 10 minutes.

The owner of the addresses isn't contacted, but what comes back is personal data. So `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take a username:

- [maigret](https://otinstaller.com/osintverse-community/maigret): finds accounts rather than email addresses, on 3,000+ sites, with profile details.
- [user-scanner](https://otinstaller.com/osintverse-community/user-scanner): checks whether a username or email is registered on 2,700+ sites and services.
- [sherlock](https://otinstaller.com/osintverse-community/sherlock): finds accounts for a username across 400+ sites.

Once mailcat has found an address, [holehe](https://otinstaller.com/osintverse-community/holehe) checks which sites it is registered on.

Packaged version: 0.1.2.
