# holehe (community package)

This repository packages [github.com/megadose/holehe](https://github.com/megadose/holehe) for the OTInstaller Registry as `osintverse-community/holehe`. The tool is the work of its authors, under the GPL-3.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/holehe`: the package is transferred to you.

The `Dockerfile` here builds the upstream release at a pinned version, and the `otinstaller release` workflow builds, signs and publishes the image.

## What it does and when to use it

Holehe checks whether an email address is attached to an account on more than 120 sites, Twitter, Instagram and Imgur among them. It asks each site through its forgotten-password function and, according to its authors, doesn't alert the owner of the address.

Use it when you have an email address and want to know which services it was used to sign up for. Each hit is a lead: a site to look for a profile on, a username to try elsewhere, or a reason to check breach data.

## Run it

```
ot run osintverse-community/holehe e:ada@example.com
```

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install holehe
otlite run holehe -- e:ada@example.com
```

## What you get back

Plain text. This package runs Holehe with `--only-used`, so it lists only the sites where the address is in use, one `[+]` line each, then a legend and a count of the sites checked. The end of the registry's scan of this release, for the address `example@example.com`:

```
[+] replit.com
[+] spotify.com
[+] twitter.com

[+] Email used, [-] Email not used, [x] Rate limit
121 websites checked in 10.06 seconds
```

`[x]` marks a site that refused the check because of its rate limit; the upstream advice is to try again from another IP address. `ot` saves the text and lists the domains and URLs it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

No API key. It needs the network: the checks go to each of the 120+ sites, from your address. This package stops a run after 10 minutes.

The address's owner isn't contacted or notified. The input is an email address and the results are personal data, so `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take an email address:

- [user-scanner](https://otinstaller.com/osintverse-community/user-scanner): checks whether a username or email is registered on 2,700+ sites and services.
- [socialscan](https://otinstaller.com/osintverse-community/socialscan): given an address with `--query`, checks Instagram, Twitter, GitHub, Tumblr, Last.fm, Pinterest and Firefox through their sign-up servers.
- [hibp-breaches](https://otinstaller.com/osintverse-community/hibp-breaches): lists the data breaches the address appears in, from Have I Been Pwned (needs a key).

Packaged version: 1.61.2.
