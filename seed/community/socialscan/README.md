# socialscan (community package)

This repository packages [github.com/iojw/socialscan](https://github.com/iojw/socialscan) for the OTInstaller Registry as `osintverse-community/socialscan`. The tool is the work of its authors, under the MPL-2.0 license; this repository only holds the manifest and release workflow.

Report problems with the tool upstream, and problems with the packaging here. If you maintain the upstream project and want to publish it yourself, open an issue or run `ot claim osintverse-community/socialscan`: the package is transferred to you.

It installs the upstream project's own release from PyPI, pinned by version and hash; nothing here is rebuilt.

## What it does and when to use it

socialscan checks whether a username or an email address is in use on major platforms, and says for each one whether it is available, taken or invalid. Rather than requesting profile pages, it queries each platform's registration servers, so reserved words and the names of deleted or banned accounts show up as taken instead of available.

It covers fewer sites than tools such as Sherlock, but answers fast. Usernames are checked on Instagram, Twitter, GitHub, Tumblr, Last.fm, Snapchat, GitLab, Reddit and Yahoo; email addresses on Instagram, Twitter, GitHub, Tumblr, Last.fm, Pinterest and Firefox. Use it to confirm whether a handle or address is registered on those platforms, or pass `--platforms` to check just one.

## Run it

```
ot run osintverse-community/socialscan u:johndoe
ot run osintverse-community/socialscan --query ada@example.com
ot run osintverse-community/socialscan u:johndoe --platforms GitHub
```

An email address goes in `--query`, the same input as a username.

otlite, the no-Docker edition for Linux and macOS, has it too:

```
otlite install socialscan
otlite run socialscan -- q:johndoe
```

## What you get back

Plain text: a header with what you asked about, a legend (`Available, Taken/Reserved, Invalid, Error`), then a line per platform with its answer. This package passes `--show-urls`, which adds the profile URL for usernames on platforms that have profile pages; the profile may not exist if the name is reserved or belonged to a deleted or banned account.

Platforms can refuse queries that come too fast. In the registry's scan of this release, for the username `github` on GitHub, the answer was:

```
GitHub: QueryError - Could not retrieve token. You might be sending too many requests. Use a proxy or wait before trying again.
```

`ot` saves the text and lists the URLs and email addresses it mentions as entities in its result, marked low confidence because they were read from text.

## Keys and network

No API key. It needs the network: the queries go to each platform from your address. This package stops a run after 5 minutes.

The person behind the name isn't contacted, but what comes back is personal data. So `ot mcp` asks you before an agent runs it, and a script without a terminal has to pass `--yes`.

## Alternatives

Other packages that take a username or email address:

- [user-scanner](https://otinstaller.com/osintverse-community/user-scanner): checks whether a username or email is registered on 2,700+ sites and services.
- [sherlock](https://otinstaller.com/osintverse-community/sherlock): finds accounts for a username across 400+ sites.
- [holehe](https://otinstaller.com/osintverse-community/holehe): checks whether an email address is registered on 120+ sites.

Packaged version: 2.0.2.
