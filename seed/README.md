# Launch seed: 40 tools and 10 guides

Everything needed to seed the production registry for launch (plan week 10: "40 tools and 10 guides seeded";
exit criterion "all seeded packages healthy"). Nothing here is published or sent anywhere yet: each folder becomes
its own repository, and packages reach the registry only through the normal pipeline (tag → validation → scan or
content checks → review → published). Never seed production from `api/scripts/seed-lib.mjs` or `spec/fixtures`
(fake digests) or with SQL.

| Folder | What | Count |
| --- | --- | --- |
| [`first-party/`](first-party) | Tools written for the registry, on the result envelope, namespace `osintverse-community` | 11 |
| [`community/`](community) | Wrapper repositories for third-party tools, namespace `osintverse-community` (27 for launch, 26 published and `instaloader-profile` dropped; 11 converted from `otinstaller`) | 38 |
| [`guides/`](guides) | Launch guides, namespace `osintverse-community` | 10 |
| [`outreach/`](outreach) | Issue and pull request texts for maintainer outreach | 2 |

Two more tools are **outreach only**: `p1ngul1n0/blackbird` (now `antoniaci/blackbird`), whose author removed its
license in May 2024, so nobody may redistribute it, and `mxrch/GHunt` (AGPL-3.0), which can't do anything until it is
logged in to a Google account, so a wrapper could never run unattended. That makes 40 tools.

Community wrappers accept any license in the API's redistributable list (`api/src/imports.ts`), the AGPL included: a
wrapper installs the upstream project unmodified, credits it and links its source, which is what those licenses ask
of a redistribution. The AGPL's network clause covers modified versions offered over a network, which wrappers are
not.

## Tools

| Package | Version | License | Upstream | Runtime | Inputs | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| `osintverse-community/maigret` | 0.6.6 | MIT | soxoj/maigret | pipx (PyPI wheel) | `username` (username), `site` (string)?, `top_sites` (integer)? | username, social-media |
| `osintverse-community/naminter` | 1.0.9 | MIT | 3xp0rt/Naminter | Docker, built in wrapper | `username` (username), `category` (string)? | username |
| `osintverse-community/sherlock` | 0.16.2 | MIT | sherlock-project/sherlock | pipx (PyPI wheel) | `username` (username), `site` (string)? | username, social-media |
| `osintverse-community/socialscan` | 2.0.1 | MPL-2.0 | iojw/socialscan | pipx (PyPI wheel) | `query` (username), `platforms` (string)? | username, email, social-media |
| `osintverse-community/username-permutations` | 0.1.0 | MIT | first-party | Docker, built here | `name` (name), `extra` (string)? | username, people |
| `osintverse-community/checkdmarc` | 6.0.4 | Apache-2.0 | domainaware/checkdmarc | pipx (PyPI wheel) | `domain` (domain) | email, domain-dns |
| `osintverse-community/holehe` | 1.61.0 | GPL-3.0 | megadose/holehe | Docker, built in wrapper | `email` (email) | email |
| `osintverse-community/mailcat` | 0.1.1 | Apache-2.0 | sharsil/mailcat | pipx (PyPI wheel) | `username` (username), `provider` (string)? | email, username |
| `osintverse-community/email-header-parser` | 0.1.0 | MIT | first-party | Docker, built here | `headers` (string) | email |
| `osintverse-community/dnsrecon` | 1.6.3 | GPL-2.0 | darkoperator/dnsrecon | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/dnstwist` | 20250130.0.0 | Apache-2.0 | elceef/dnstwist | pipx (PyPI wheel) | `domain` (domain) | domain-dns |
| `osintverse-community/httpx` | 1.12.0 | MIT | projectdiscovery/httpx | Docker, built in wrapper | `target` (url) | domain-dns, ip-network |
| `osintverse-community/subfinder` | 2.17.0 | MIT | projectdiscovery/subfinder | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/theharvester` | 4.11.1 | GPL-2.0 | laramies/theHarvester | Docker, built in wrapper | `domain` (domain), `sources` (string)? | domain-dns, email |
| `osintverse-community/tldextract` | 5.4.0 | BSD-3-Clause | john-kurkowski/tldextract | pipx (PyPI wheel) | `url` (url) | domain-dns, utilities |
| `osintverse-community/tlsx` | 1.4.0 | MIT | projectdiscovery/tlsx | Docker, built in wrapper | `host` (domain) | domain-dns, ip-network |
| `osintverse-community/crtsh-subdomains` | 0.1.0 | MIT | first-party | Docker, built here | `domain` (domain) | domain-dns |
| `osintverse-community/dns-records` | 0.1.0 | MIT | first-party | Docker, built here | `domain` (domain), `types` (string)? | domain-dns |
| `osintverse-community/cdncheck` | 1.3.2 | MIT | projectdiscovery/cdncheck | Docker, built in wrapper | `target` (string) | ip-network |
| `osintverse-community/ipwhois` | 1.3.0 | BSD-2-Clause | secynic/ipwhois | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/mapcidr` | 1.1.97 | MIT | projectdiscovery/mapcidr | Docker, built in wrapper | `cidr` (string) | ip-network, utilities |
| `osintverse-community/naabu` | 2.6.1 | MIT | projectdiscovery/naabu | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/shodan-host` | 1.31.0 | MIT | achillean/shodan-python | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/ignorant` | 1.2.0 | GPL-3.0 | megadose/ignorant | pipx (PyPI wheel) | `country_code` (string), `phone` (phone) | phone, social-media |
| `osintverse-community/phoneinfoga` | 2.11.0 | GPL-3.0 | sundowndev/phoneinfoga | Docker, built in wrapper | `phone` (phone) | phone |
| `osintverse-community/phone-parse` | 0.1.0 | MIT | first-party | Docker, built here | `phone` (phone), `region` (string)? | phone |
| `osintverse-community/exif-meta` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url) | images-geo, documents-metadata |
| `osintverse-community/geo-links` | 0.1.0 | MIT | first-party | Docker, built here | `coordinates` (string) | images-geo |
| `osintverse-community/image-hash` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url), `compare` (url)? | images-geo |
| `osintverse-community/reverse-image-links` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url), `engines` (string)? | images-geo |
| `osintverse-community/gallery-dl` | 1.32.17 | GPL-2.0 | mikf/gallery-dl | pipx (PyPI wheel) | `url` (url) | social-media, images-geo |
| `osintverse-community/yt-dlp` | 2026.8.19 | Unlicense | yt-dlp/yt-dlp | pipx (PyPI wheel) | `url` (url) | social-media |
| `osintverse-community/btc-address` | 0.1.0 | MIT | first-party | Docker, built here | `address` (crypto_address) | crypto |
| `osintverse-community/eth-address` | 0.1.0 | MIT | first-party | Docker, built here | `address` (crypto_address) | crypto |
| `osintverse-community/gau` | 2.2.4 | MIT | lc/gau | Docker, built in wrapper | `domain` (domain) | web-archive, domain-dns |
| `osintverse-community/waybackpy` | 3.0.6 | MIT | akamhy/waybackpy | pipx (PyPI wheel) | `url` (url), `mode` (enum) | web-archive, utilities |
| `osintverse-community/unfurl` | 20261007.0.0 | Apache-2.0 | RyanDFIR/unfurl | pipx (PyPI wheel) | `url` (url) | utilities, web-archive |

Licenses were read from each repository (GitHub's detection, or the license file where GitHub says NOASSERTION) and
match the registry's `REDISTRIBUTABLE` list for wrappers. pipx wrappers pin the exact wheel by SHA-256 from PyPI;
Docker wrappers pin the upstream version (Go tools by module version, phoneinfoga by release checksum).

## Converted from the otinstaller catalog

11 more wrappers come from the catalog of `otinstaller`, the older package manager in [`../python`](../python), written
by `python scripts/pm-catalog-to-wrappers.py`. They follow the same rules as the launch wrappers (outreach first,
then publish), but were generated rather than hand-tuned. Docker ones build for `linux/amd64` and `linux/arm64` (each was built and run on arm64 under emulation). Git installs
pinned to a commit get the version `0.0.0-git.<commit>`.

Each was built and run with its `test.input` under `ot`'s own sandbox flags (read-only root, only `/tmp` writable, user
65534, no capabilities, 1 GB, 2 CPUs). All 11 return results except `ctfr`, which exits 1 while crt.sh answers 502 (a
known crt.sh outage, not the wrapper). Tools that failed this test the same way on a second input were left out
rather than published broken; the table below says why. Run `ot validate --smoke` again after the first release.

| Package | Version | License | Upstream | Runtime | Inputs | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| `osintverse-community/aliens-eye` | 2.7.0 | MIT | arxhr007/Aliens_eye | Docker, built in wrapper | `username` (username) | username, social-media |
| `osintverse-community/paramspider` | 0.1.0 | MIT | devanshbatham/ParamSpider | Docker, built in wrapper | `domain` (domain) | domain-dns, utilities, documents-metadata |
| `osintverse-community/nexfil` | 1.0.6 | MIT | thewhiteh4t/nexfil | pipx (PyPI wheel) | `username` (username) | username, social-media |
| `osintverse-community/onionsearch` | 1.3.0 | GPL-3.0 | megadose/OnionSearch | pipx (PyPI wheel) | `query` (string) | utilities |
| `osintverse-community/sublist3r` | 1.0.0 | GPL-2.0 | aboul3la/Sublist3r | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/socid-extractor` | 0.1.1 | MIT | soxoj/socid-extractor | pipx (PyPI wheel) | `url` (url) | utilities, username, documents-metadata |
| `osintverse-community/linkook` | 1.1.3 | MIT | JackJuly/linkook | pipx (PyPI wheel) | `username` (username) | username, email, social-media |
| `osintverse-community/finalrecon` | 0.0.0-git.b5db3a4 | MIT | thewhiteh4t/FinalRecon | Docker, built in wrapper | `url` (url) | domain-dns, ip-network, utilities |
| `osintverse-community/fierce` | 1.6.0 | GPL-3.0 | mschwager/fierce | pipx (PyPI wheel) | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/ctfr` | 0.0.0-git.6c7fecd | GPL-3.0 | UnaPibaGeek/ctfr | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/thebigbrother` | 7.0.0 | MIT | chadi0x/TheBigBrother | Docker, built in wrapper | `username` (username) | username |

Not converted (the script prints the same reasons):

| Reason | Tools |
| --- | --- |
| Already in the launch seed | maigret, theharvester, sherlock, holehe, dnstwist, ignorant, socialscan |
| Outreach only (see above) | ghunt, blackbird |
| No clear license (NOASSERTION) | h8mail, torbot, secator |
| Four-part version (1.5.2.2) that isn't semver | user-scanner |
| Needs a login or config file first | toutatis, whatsapp-osint, telegram-phone-number-checker, auto-archiver, telepathy |
| No typed input to map onto manifest inputs | ivre, yark, openosint, crosslinked, dnsgen, osint-brazuca-regex, pywerview |
| Prompts for input or runs until stopped | fsociety, instagram-monitor, sitedorks |
| A passive scan runs for more than an hour, past ot's longest timeout | spiderfoot |
| Instagram blocks anonymous requests from cloud servers, so its health check can't pass | instaloader |
| Installs system packages with sudo when it runs, which ot's sandbox (no root) refuses | bbot |
| Writes into its own install folder at startup, which ot's read-only sandbox refuses | mailaccess |
| Writes its results only to a file, not to stdout | edgar-tool |
| Drives Chrome through Selenium, which the wrapper image lacks | instagram-location-search |
| ProtonMail's API rejects its requests, so it never returns a result | neutrosint |
| GitHub answers its requests with an HTML page, so it never returns a result | zen |

## How each part gets published

Order matters: namespaces first, then tools, then guides (a guide's `related_tools` must already be published).
The step-by-step runbook with commands is in the session notes (`seeding.md`); in short:

1. **Namespace.** Everything publishes under the `osintverse-community` GitHub organisation (approved and verified on
   the registry), first-party tools and guides included.
2. **First-party tools.** Create `osintverse-community/<name>` for each folder in `first-party/`, push its contents, run the
   **otinstaller release** workflow with `0.1.0`. The workflow builds, signs and pins the image and tags.
3. **Third-party tools: outreach first.** For each upstream, post [`outreach/issue.md`](outreach/issue.md) and, if
   the maintainer is interested, open [`outreach/pr.md`](outreach/pr.md) with the manifest from `community/<name>/`
   adapted to their namespace. If they publish it themselves, drop the wrapper.
4. **Community wrappers** after 14 days without an answer. Either run the import wizard with `community: true` and
   finish in wrapper mode, or create `osintverse-community/<name>`, push the folder and tag `v<version>` (pipx) or run
   the release workflow (Docker). The package is labelled Community-packaged, and the upstream maintainer can
   `ot claim` it.
5. **Guides.** Create `osintverse-community/<name>` for each folder in `guides/`, push, run the release workflow with `1.0.0`.

## Checked so far

- `ot validate` passes for all 48 manifests.
- Unit tests pass for all 11 first-party tools (`python -m unittest` in each folder). The network ones were also run
  against their live APIs with their test inputs.
- These wrappers were run locally with their exact command and test input: sherlock, socialscan, checkdmarc,
  gallery-dl, yt-dlp, waybackpy, unfurl, ignorant, mailcat, ipwhois (module). The smoke runs found and fixed four
  problems: socialscan's `--platforms` swallowing the query, unfurl's `--type json` printing Python instead of JSON,
  ipwhois's console script exiting 1, and a waybackpy test URL with no captures.
- No guide page trips the personal-data check; every link to a tool or guide points at something in this seed.

Not checked here (no Docker on the machine this was prepared on): building the Docker images and running
`ot validate --smoke` on them; maigret and naminter (their dependencies don't install on Windows).

## Dropped

`instaloader-profile` is not published and its repository is archived: Instagram redirects anonymous requests from
cloud servers to its login page, so the scan's smoke test and the nightly health check can never pass.

## Health risks to watch after publishing

The exit criterion is that every seeded package is healthy in the nightly check, which runs each tool's
`test.input` from GitHub Actions runners. Expect trouble from:

| Package | Risk | If it fails |
| --- | --- | --- |
| `osintverse-community/shodan-host` | Needs `SHODAN_API_KEY`; the health job passes no secrets | Give the health job a key, or count it as not checkable |
| `osintverse-community/yt-dlp` | YouTube blocks cloud IPs ("Sign in to confirm") | The test input is an Internet Archive video; YouTube URLs still work for most users |
| `osintverse-community/crtsh-subdomains` | crt.sh is often down | Falls back to Cert Spotter (limited to a few lookups an hour without a key) |
| `osintverse-community/maigret`, `naminter`, `mailcat` | Not run end to end here | Run `ot validate --smoke` after the first release |

## Updating a wrapper

Change `version` (and for pipx wrappers `package_version` and `wheel_sha256`, from
`https://pypi.org/pypi/<package>/json`), then tag, or run the release workflow for Docker wrappers.
