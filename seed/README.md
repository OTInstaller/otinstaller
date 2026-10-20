# Launch seed: 40 tools and 10 guides

Everything needed to seed the production registry for launch (plan week 10: "40 tools and 10 guides seeded";
exit criterion "all seeded packages healthy"). Nothing here is published or sent anywhere yet: each folder becomes
its own repository, and packages reach the registry only through the normal pipeline (tag → validation → scan or
content checks → review → published). Never seed production from `api/scripts/seed-lib.mjs` or `spec/fixtures`
(fake digests) or with SQL.

| Folder | What | Count |
| --- | --- | --- |
| [`first-party/`](first-party) | Tools written for the registry, namespace `osintverse`, on the result envelope | 11 |
| [`community/`](community) | Wrapper repositories for third-party tools, namespace `osintverse-community` (26 published; `instaloader-profile` dropped) | 27 |
| [`guides/`](guides) | Launch guides, namespace `osintverse` | 10 |
| [`outreach/`](outreach) | Issue and pull request texts for maintainer outreach | 2 |

Two more tools are **outreach only**, because their licenses don't allow a community wrapper:
`p1ngul1n0/blackbird` (now `antoniaci/blackbird`, no license) and `mxrch/GHunt` (AGPL-3.0, which the registry does
not accept for wrappers). That makes 40 tools.

## Tools

| Package | Version | License | Upstream | Runtime | Inputs | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| `osintverse-community/maigret` | 0.6.6 | MIT | soxoj/maigret | pipx (PyPI wheel) | `username` (username), `site` (string)?, `top_sites` (integer)? | username, social-media |
| `osintverse-community/naminter` | 1.0.9 | MIT | 3xp0rt/Naminter | Docker, built in wrapper | `username` (username), `category` (string)? | username |
| `osintverse-community/sherlock` | 0.16.2 | MIT | sherlock-project/sherlock | pipx (PyPI wheel) | `username` (username), `site` (string)? | username, social-media |
| `osintverse-community/socialscan` | 2.0.1 | MPL-2.0 | iojw/socialscan | pipx (PyPI wheel) | `query` (username), `platforms` (string)? | username, email, social-media |
| `osintverse/username-permutations` | 0.1.0 | MIT | first-party | Docker, built here | `name` (name), `extra` (string)? | username, people |
| `osintverse-community/checkdmarc` | 6.0.4 | Apache-2.0 | domainaware/checkdmarc | pipx (PyPI wheel) | `domain` (domain) | email, domain-dns |
| `osintverse-community/holehe` | 1.61.0 | GPL-3.0 | megadose/holehe | Docker, built in wrapper | `email` (email) | email |
| `osintverse-community/mailcat` | 0.1.1 | Apache-2.0 | sharsil/mailcat | pipx (PyPI wheel) | `username` (username), `provider` (string)? | email, username |
| `osintverse/email-header-parser` | 0.1.0 | MIT | first-party | Docker, built here | `headers` (string) | email |
| `osintverse-community/dnsrecon` | 1.6.3 | GPL-2.0 | darkoperator/dnsrecon | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/dnstwist` | 20250130.0.0 | Apache-2.0 | elceef/dnstwist | pipx (PyPI wheel) | `domain` (domain) | domain-dns |
| `osintverse-community/httpx` | 1.12.0 | MIT | projectdiscovery/httpx | Docker, built in wrapper | `target` (url) | domain-dns, ip-network |
| `osintverse-community/subfinder` | 2.17.0 | MIT | projectdiscovery/subfinder | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/theharvester` | 4.11.1 | GPL-2.0 | laramies/theHarvester | Docker, built in wrapper | `domain` (domain), `sources` (string)? | domain-dns, email |
| `osintverse-community/tldextract` | 5.4.0 | BSD-3-Clause | john-kurkowski/tldextract | pipx (PyPI wheel) | `url` (url) | domain-dns, utilities |
| `osintverse-community/tlsx` | 1.4.0 | MIT | projectdiscovery/tlsx | Docker, built in wrapper | `host` (domain) | domain-dns, ip-network |
| `osintverse/crtsh-subdomains` | 0.1.0 | MIT | first-party | Docker, built here | `domain` (domain) | domain-dns |
| `osintverse/dns-records` | 0.1.0 | MIT | first-party | Docker, built here | `domain` (domain), `types` (string)? | domain-dns |
| `osintverse-community/cdncheck` | 1.3.2 | MIT | projectdiscovery/cdncheck | Docker, built in wrapper | `target` (string) | ip-network |
| `osintverse-community/ipwhois` | 1.3.0 | BSD-2-Clause | secynic/ipwhois | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/mapcidr` | 1.1.97 | MIT | projectdiscovery/mapcidr | Docker, built in wrapper | `cidr` (string) | ip-network, utilities |
| `osintverse-community/naabu` | 2.6.1 | MIT | projectdiscovery/naabu | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/shodan-host` | 1.31.0 | MIT | achillean/shodan-python | Docker, built in wrapper | `ip` (ip) | ip-network |
| `osintverse-community/ignorant` | 1.2.0 | GPL-3.0 | megadose/ignorant | pipx (PyPI wheel) | `country_code` (string), `phone` (phone) | phone, social-media |
| `osintverse-community/phoneinfoga` | 2.11.0 | GPL-3.0 | sundowndev/phoneinfoga | Docker, built in wrapper | `phone` (phone) | phone |
| `osintverse/phone-parse` | 0.1.0 | MIT | first-party | Docker, built here | `phone` (phone), `region` (string)? | phone |
| `osintverse/exif-meta` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url) | images-geo, documents-metadata |
| `osintverse/geo-links` | 0.1.0 | MIT | first-party | Docker, built here | `coordinates` (string) | images-geo |
| `osintverse/image-hash` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url), `compare` (url)? | images-geo |
| `osintverse/reverse-image-links` | 0.1.0 | MIT | first-party | Docker, built here | `url` (url), `engines` (string)? | images-geo |
| `osintverse-community/gallery-dl` | 1.32.17 | GPL-2.0 | mikf/gallery-dl | pipx (PyPI wheel) | `url` (url) | social-media, images-geo |
| `osintverse-community/yt-dlp` | 2026.8.19 | Unlicense | yt-dlp/yt-dlp | pipx (PyPI wheel) | `url` (url) | social-media |
| `osintverse/btc-address` | 0.1.0 | MIT | first-party | Docker, built here | `address` (crypto_address) | crypto |
| `osintverse/eth-address` | 0.1.0 | MIT | first-party | Docker, built here | `address` (crypto_address) | crypto |
| `osintverse-community/gau` | 2.2.4 | MIT | lc/gau | Docker, built in wrapper | `domain` (domain) | web-archive, domain-dns |
| `osintverse-community/waybackpy` | 3.0.6 | MIT | akamhy/waybackpy | pipx (PyPI wheel) | `url` (url), `mode` (enum) | web-archive, utilities |
| `osintverse-community/unfurl` | 20261007.0.0 | Apache-2.0 | RyanDFIR/unfurl | pipx (PyPI wheel) | `url` (url) | utilities, web-archive |

Licenses were read from each repository (GitHub's detection, or the license file where GitHub says NOASSERTION) and
match the registry's `REDISTRIBUTABLE` list for wrappers. pipx wrappers pin the exact wheel by SHA-256 from PyPI;
Docker wrappers pin the upstream version (Go tools by module version, phoneinfoga by release checksum).

## How each part gets published

Order matters: namespaces first, then tools, then guides (a guide's `related_tools` must already be published).
The step-by-step runbook with commands is in the session notes (`seeding.md`); in short:

1. **Namespaces.** Create the GitHub organisations `osintverse` and `osintverse-community`, install the OTInstaller
   GitHub App on both, and approve and verify them in the admin console.
2. **First-party tools.** Create `osintverse/<name>` for each folder in `first-party/`, push its contents, run the
   **otinstaller release** workflow with `0.1.0`. The workflow builds, signs and pins the image and tags.
3. **Third-party tools: outreach first.** For each upstream, post [`outreach/issue.md`](outreach/issue.md) and, if
   the maintainer is interested, open [`outreach/pr.md`](outreach/pr.md) with the manifest from `community/<name>/`
   adapted to their namespace. If they publish it themselves, drop the wrapper.
4. **Community wrappers** after 14 days without an answer. Either run the import wizard with `community: true` and
   finish in wrapper mode, or create `osintverse-community/<name>`, push the folder and tag `v<version>` (pipx) or run
   the release workflow (Docker). The package is labelled Community-packaged, and the upstream maintainer can
   `ot claim` it.
5. **Guides.** Create `osintverse/<name>` for each folder in `guides/`, push, run the release workflow with `1.0.0`.

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
| `osintverse/crtsh-subdomains` | crt.sh is often down | Falls back to Cert Spotter (limited to a few lookups an hour without a key) |
| `osintverse-community/maigret`, `naminter`, `mailcat` | Not run end to end here | Run `ot validate --smoke` after the first release |

## Updating a wrapper

Change `version` (and for pipx wrappers `package_version` and `wheel_sha256`, from
`https://pypi.org/pypi/<package>/json`), then tag, or run the release workflow for Docker wrappers.
