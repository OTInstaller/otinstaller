# Launch seed: 40 tools and 10 guides

Everything needed to seed the production registry for launch (plan week 10: "40 tools and 10 guides seeded";
exit criterion "all seeded packages healthy"). Nothing here is published or sent anywhere yet: each folder becomes
its own repository, and packages reach the registry only through the normal pipeline (tag → validation → scan or
content checks → review → published). Never seed production from `api/scripts/seed-lib.mjs` or `spec/fixtures`
(fake digests) or with SQL.

| Folder | What | Count |
| --- | --- | --- |
| [`first-party/`](first-party) | Tools written for the registry, on the result envelope, namespace `osintverse-community` (11 for launch; 9 built on data providers' official PyPI clients and 6 on providers' HTTP APIs in October 2026) | 26 |
| [`community/`](community) | Wrapper repositories for third-party tools, namespace `osintverse-community` (27 for launch, 26 published and `instaloader-profile` dropped; 11 converted from `otinstaller`; 65 open-source tools with more than 100 stars added in October 2026; 16 PyPI clients of data providers added in October 2026) | 119 |
| [`guides/`](guides) | Launch guides, namespace `osintverse-community` (10 published; `osint-fundamentals` is a draft primer for `/learn`, not published yet) | 11 |

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
| Instagram blocks anonymous requests from cloud servers, so the scan's smoke test can't pass | instaloader |
| Installs system packages with sudo when it runs, which ot's sandbox (no root) refuses | bbot |
| Writes into its own install folder at startup, which ot's read-only sandbox refuses | mailaccess |
| Writes its results only to a file, not to stdout | edgar-tool |
| Drives Chrome through Selenium, which the wrapper image lacks | instagram-location-search |
| ProtonMail's API rejects its requests, so it never returns a result | neutrosint |
| GitHub answers its requests with an HTML page, so it never returns a result | zen |

## Open-source tools with more than 100 stars (October 2026)

65 more wrappers aim at breadth: every open-source OSINT tool on GitHub or GitLab with more than 100 stars that
could be wrapped. At the owner's request they were published straight away on 22 Oct 2026, without the outreach
step. 19 are pipx wrappers pinned to a PyPI wheel by SHA-256 and 46 are Docker wrappers that build a pinned upstream release
(a tag, a module version or, with no usable release, a full commit; those get the version `0.0.0-git.<commit>`).

How the list was built, on 22 Oct 2026:

1. Candidates: GitHub searches for the topics `osint`, `recon`, `reconnaissance`, `osint-tool(s)`,
   `information-gathering`, `subdomain-enumeration`, `osint-python`, `osint-framework`, `username-checker`,
   `email-osint`, `dns-enumeration`, `threat-intelligence`, `whois`, `subdomain-finder`, `asset-discovery`,
   `attack-surface`, `socmint`, `geoint`, `certificate-transparency`, `web-archive`, `bug-bounty` and others, plus
   keyword searches for "osint" and "reconnaissance", plus every GitHub repository linked from jivoi/awesome-osint,
   cipher387/osint_stuff_tool_collection, Astrosp/Awesome-OSINT-For-Everything, sinwindie/OSINT and
   tracelabs/awesome-osint. GitLab's topic and name searches found one project over 100 stars (kennbroorg/iKy, a web
   app). About 1,850 repositories had more than 100 stars.
2. Automatic filters: already in the seed (31), forks (2), archived (119), no license GitHub can identify (530), a
   license outside the API's `REDISTRIBUTABLE` list (none left after the others), or abandoned, meaning no commit
   since October 2024 (379).
3. Screening by name, description and topics took out what isn't a single-target command-line OSINT tool: lists and
   guides, datasets, web apps and dashboards, platforms, libraries, browser extensions, AI-agent and MCP projects,
   and general security tools.
4. The remaining 135 were read one by one (README, packaging, argument parser, latest release, PyPI) and either
   wrapped or dropped with a reason.

Every repository and its outcome is in [`candidates.md`](candidates.md).

| Package | Version | License | Upstream | Runtime | Inputs | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| `osintverse-community/ail-typo-squatting` | 2.7.6 | BSD-2-Clause | typosquatter/ail-typo-squatting | pipx (PyPI wheel) | `domain` (domain), `limit` (integer)? | domain-dns |
| `osintverse-community/alterx` | 0.1.0 | MIT | projectdiscovery/alterx | Docker, built in wrapper | `domain` (domain), `limit` (integer)? | domain-dns |
| `osintverse-community/anubis` | 1.3.1 | MIT | jonluca/anubis | pipx (PyPI wheel) | `domain` (domain) | domain-dns |
| `osintverse-community/asn` | 0.83.0 | MIT | nitefood/asn | Docker, built in wrapper | `target` (string) | ip-network, company |
| `osintverse-community/asnmap` | 1.1.1 | MIT | projectdiscovery/asnmap | Docker, built in wrapper | `org` (company) | ip-network, company |
| `osintverse-community/carbon14` | 1.0.0 | GPL-3.0 | Lazza/Carbon14 | pipx (PyPI wheel) | `url` (url), `author` (string)? | documents-metadata, images-geo |
| `osintverse-community/cloud-enum` | 0.9.0 | MIT | initstring/cloud_enum | Docker, built in wrapper | `keyword` (string) | company, domain-dns |
| `osintverse-community/crt-sh` | 3.0.4 | MIT | az7rb/crt.sh | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/csprecon` | 0.4.7 | MIT | edoardottt/csprecon | Docker, built in wrapper | `url` (url), `filter` (domain)? | domain-dns |
| `osintverse-community/cut-cdn` | 0.0.0-git.2105f01 | MIT | ImAyrix/cut-cdn | Docker, built in wrapper | `target` (ip) | ip-network, domain-dns |
| `osintverse-community/ddgr` | 2.2.0 | GPL-3.0 | jarun/ddgr | pipx (PyPI wheel) | `query` (string), `site` (domain)?, `num` (integer)? | utilities |
| `osintverse-community/dnsanity` | 1.4.2 | MIT | nil0x42/dnsanity | Docker, built in wrapper | `servers` (ip) | ip-network, domain-dns |
| `osintverse-community/dnsx` | 1.3.1 | MIT | projectdiscovery/dnsx | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/favicorn` | 0.1.1 | Apache-2.0 | sharsil/favicorn | pipx (PyPI wheel) | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/favihunter` | 1.4.0 | MIT | eremit4/favihunter | pipx (PyPI wheel) | `url` (url) | domain-dns, ip-network |
| `osintverse-community/favirecon` | 1.0.4 | MIT | edoardottt/favirecon | Docker, built in wrapper | `target` (url) | domain-dns, ip-network |
| `osintverse-community/findcdn` | 0.0.0-git.7bbf50e | CC0-1.0 | cisagov/findcdn | Docker, built in wrapper | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/findomain` | 10.0.1 | GPL-3.0 | Findomain/Findomain | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/geointel` | 0.2.0 | MIT | atiilla/GeoIntel | pipx (PyPI wheel) | `image_url` (url), `context` (string)?, `guess` (string)? | images-geo |
| `osintverse-community/getjs` | 2.0.0 | MIT | 003random/getJS | Docker, built in wrapper | `url` (url) | domain-dns |
| `osintverse-community/gitcolombo` | 0.3.0 | MIT | soxoj/gitcolombo | Docker, built in wrapper | `url` (url) | email, people, username |
| `osintverse-community/gitxray` | 1.0.20 | AGPL-3.0 | kulkansecurity/gitxray | pipx (PyPI wheel) | `repository` (string) | username, documents-metadata |
| `osintverse-community/gogetcrawl` | 1.1.3 | MIT | karust/gogetcrawl | Docker, built in wrapper | `domain` (domain), `limit` (integer)? | web-archive, domain-dns |
| `osintverse-community/goverview` | 1.0.1 | MIT | j3ssie/goverview | Docker, built in wrapper | `url` (url) | domain-dns |
| `osintverse-community/gowitness` | 3.2.2 | GPL-3.0 | sensepost/gowitness | Docker, built in wrapper | `url` (url) | domain-dns, images-geo |
| `osintverse-community/greynoise` | 3.1.0 | MIT | GreyNoise-Intelligence/pygreynoise | pipx (PyPI wheel) | `ip` (ip) | ip-network |
| `osintverse-community/hakrawler` | 0.0.0-git.52a16fe | GPL-3.0 | hakluke/hakrawler | Docker, built in wrapper | `url` (url), `depth` (integer)? | domain-dns, web-archive |
| `osintverse-community/htmldate` | 1.11.0 | Apache-2.0 | adbar/htmldate | pipx (PyPI wheel) | `url` (url) | documents-metadata, web-archive |
| `osintverse-community/indicator-intelligence` | 1.1.1 | GPL-3.0 | OsmanKandemir/indicator-intelligence | Docker, built in wrapper | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/investigo` | 0.0.0-git.3ed07ed | MIT | tdh8316/Investigo | Docker, built in wrapper | `username` (username), `sites` (string)? | username, social-media |
| `osintverse-community/ioc-finder` | 9.4.1 | LGPL-3.0 | fhightower/ioc-finder | pipx (PyPI wheel) | `text` (string) | utilities, ip-network, domain-dns |
| `osintverse-community/katana` | 1.8.0 | MIT | projectdiscovery/katana | Docker, built in wrapper | `url` (url), `depth` (integer)? | domain-dns, web-archive |
| `osintverse-community/knockpy` | 9.0.0 | GPL-3.0 | guelfoweb/knockpy | pipx (PyPI wheel) | `domain` (domain) | domain-dns |
| `osintverse-community/likexian-whois` | 1.15.7 | Apache-2.0 | likexian/whois | Docker, built in wrapper | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/linx` | 0.2.0 | MIT | riza/linx | Docker, built in wrapper | `url` (url) | domain-dns, utilities |
| `osintverse-community/marple` | 0.0.0-git.4c33136 | MIT | soxoj/marple | Docker, built in wrapper | `username` (username), `threshold` (integer)? | username, social-media |
| `osintverse-community/metabigor` | 2.2.0 | MIT | j3ssie/metabigor | Docker, built in wrapper | `domain` (domain), `sources` (string)? | domain-dns, company |
| `osintverse-community/nerva` | 1.77.0 | Apache-2.0 | praetorian-inc/nerva | Docker, built in wrapper | `target` (string) | ip-network |
| `osintverse-community/numint` | 0.0.0-git.9186c35 | MIT | whoamitang/numint | Docker, built in wrapper | `phone` (phone), `country` (string)? | phone |
| `osintverse-community/octosuite` | 5.1.0 | MIT | bellingcat/octosuite | Docker, built in wrapper | `username` (username) | username, social-media |
| `osintverse-community/opensquat` | 2.3.0 | GPL-3.0 | atenreiro/opensquat | Docker, built in wrapper | `keyword` (string), `confidence` (integer)? | domain-dns, company |
| `osintverse-community/osgint` | 0.0.0-git.866a08b | MIT | hippiiee/osgint | Docker, built in wrapper | `username` (username) | username, email, social-media |
| `osintverse-community/photon` | 0.0.0-git.c8d2566 | GPL-3.0 | s0md3v/Photon | Docker, built in wrapper | `url` (url), `dataset` (enum)?, `level` (integer)? | domain-dns, web-archive |
| `osintverse-community/puredns` | 2.1.1 | GPL-3.0 | d3mondev/puredns | Docker, built in wrapper | `domain` (domain), `rate_limit` (integer)? | domain-dns |
| `osintverse-community/pywhat` | 5.1.0 | MIT | bee-san/pyWhat | pipx (PyPI wheel) | `text` (string) | utilities |
| `osintverse-community/quien` | 0.12.0 | MIT | retlehs/quien | Docker, built in wrapper | `domain` (domain) | domain-dns, ip-network |
| `osintverse-community/radar` | 0.1.1 | MIT | Elite-Security-Systems/radar | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/robofinder` | 0.2.2 | MIT | Spix0r/robofinder | pipx (PyPI wheel) | `url` (url) | web-archive, domain-dns |
| `osintverse-community/shuffledns` | 1.2.1 | GPL-3.0 | projectdiscovery/shuffledns | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/social-analyzer` | 0.45.0 | AGPL-3.0 | qeeqbox/social-analyzer | pipx (PyPI wheel) | `username` (username), `websites` (string)?, `top` (integer)? | username, social-media |
| `osintverse-community/subdominator` | 3.0.3 | MIT | RevoltSecurities/Subdominator | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/thescrapper` | 0.0.0-git.de4b51d | GPL-3.0 | champmq/TheScrapper | Docker, built in wrapper | `url` (url), `crawl` (integer)? | email, phone, social-media |
| `osintverse-community/uncover` | 1.2.1 | MIT | projectdiscovery/uncover | Docker, built in wrapper | `query` (string), `engine` (enum)?, `limit` (integer)? | ip-network, domain-dns |
| `osintverse-community/urlfinder` | 0.0.3 | MIT | projectdiscovery/urlfinder | Docker, built in wrapper | `domain` (domain) | domain-dns, web-archive |
| `osintverse-community/urx` | 0.11.0 | MIT | hahwul/urx | Docker, built in wrapper | `domain` (domain) | web-archive, domain-dns |
| `osintverse-community/user-scanner` | 1.5.2 | MIT | kaifcodec/user-scanner | pipx (PyPI wheel) | `username` (username)?, `email` (email)? | username, email, social-media |
| `osintverse-community/waybackpack` | 0.6.4 | MIT | jsvine/waybackpack | pipx (PyPI wheel) | `url` (url), `from_date` (string)?, `to_date` (string)? | web-archive |
| `osintverse-community/waymore` | 8.9.0 | MIT | xnl-h4ck3r/waymore | pipx (PyPI wheel) | `domain` (domain), `from_date` (string)?, `to_date` (string)? | web-archive, domain-dns |
| `osintverse-community/webpalm` | 2.0.20 | GPL-3.0 | XORbit01/webpalm | Docker, built in wrapper | `url` (url), `level` (integer)? | domain-dns, utilities |
| `osintverse-community/whois` | 5.6.6 | GPL-2.0 | rfc1036/whois | Docker, built in wrapper | `query` (domain) | domain-dns, ip-network |
| `osintverse-community/x-tweet-fetcher` | 3.1.0 | MIT | ythx-101/x-tweet-fetcher | Docker, built in wrapper | `url` (url) | social-media |
| `osintverse-community/xcrawl3r` | 1.2.0 | MIT | hueristiq/xcrawl3r | Docker, built in wrapper | `url` (url), `domain` (domain)?, `depth` (integer)? | domain-dns |
| `osintverse-community/xsubfind3r` | 1.1.2 | MIT | hueristiq/xsubfind3r | Docker, built in wrapper | `domain` (domain) | domain-dns |
| `osintverse-community/xurlfind3r` | 1.3.0 | MIT | hueristiq/xurlfind3r | Docker, built in wrapper | `domain` (domain) | domain-dns, web-archive |
| `osintverse-community/youtube-transcript-api` | 1.2.4 | MIT | jdepoix/youtube-transcript-api | pipx (PyPI wheel) | `video_id` (string), `language` (string)? | social-media, documents-metadata |

None was built or run before release, at the owner's request: flags, entry points and output formats were read from
each tool's source at the pinned version. The release workflows and the registry's scans (signature, vulnerabilities,
smoke test with `test.input`) were the first real runs. All 65 passed and are published. Four needed a fix first:

| Package | Problem | Fix |
| --- | --- | --- |
| `findomain` | The vendored OpenSSL build needs `make` and `perl` | Installed in the build stage |
| `puredns` | massdns v1.1.0 no longer compiles with current GCC | massdns built from a later commit, the one `shuffledns` uses |
| `octosuite` | 5.1.0 imports `requests` without declaring it, and calls update-checker's pre-1.0 API | `requests` installed and `update-checker` pinned to 0.18.0 |
| `pyfunceble` | Crashes at start-up: its user-agent dataset no longer lists its default browser, and no flag avoids it | Dropped; its repository is archived |

Dropped after reading the tool (the full list with each reason is in [`candidates.md`](candidates.md)):

| Reason | Tools |
| --- | --- |
| Acceptable use: credential attacks, leaked credentials or breach data | chiasmod0n/chiasmodon, vflame6/leaker, ibnaleem/gosearch (searches leak databases and cracks hashes on every run), drego85/tosint (uses leaked Telegram bot tokens), N0rz3/Zehef (prints masked infostealer passwords), nodauf/GoMapEnum, nyxgeek/onedrive_user_enum, m8sec/CrossLinked, Jayy001/Search-That-Hash, mnismt/CompressedCrack, hmaverickadams/DeHashed-API-Tool |
| Acceptable use: exploits, vulnerability testing or CAPTCHA bypass | xPloits3c/DorkEye, punk-security/dnsReaper (subdomain-takeover check), and scanners and fuzzers such as projectdiscovery/nuclei, ffuf/ffuf, OJ/gobuster, s0md3v/XSStrike |
| Acceptable use: hunts exposed secrets | nsonaniya2010/SubDomainizer, eth0izzle/shhgit, tillson/git-hound |
| Acceptable use: tracks one person | Kr0wZ/SnapIntel, 0xPrateek/Stardox (bulk-collects stargazers' emails), mxrch/GitFive, misiektoja/instagram_monitor, misiektoja/spotify_monitor, IvanGlinkin/CCTV, obitouka/InstagramPrivSniffer |
| Needs a login, session or config file first | Datalux/Osintgram, megadose/toutatis, Te-k/harpoon, alexandreborges/malwoverview, JosephLai241/URS, pielco11/telescan, xadhrit/terra, eth0izzle/the-endorser, AzizKpln/Gokboru_Intel, pixelbubble/ProtOSINT, pielco11/fav-up |
| Prompts for input or runs until stopped | lanmaster53/recon-ng, kpcyrd/sn0int, divinelabio/Argus, Alfredredbird/tookie-osint, spyboy-productions/CloakQuest3r, mishakorzik/UserFinder, 0xSaikat/findme, amitrajputfff/Profil3r, s-r-e-e-r-a-j/WebSift, spider863644/PhoneNumber-OSINT, Cyber-Dioxide/IP_Rover, snooppr/shotstars, SSLMate/certspotter, securisec/chepy |
| Writes results only to files | shmilylty/OneForAll, anmolksachan/TheTimeMachine, claromes/waybacktweets, egbertbouman/youtube-comment-downloader, si9int/cc.py, bitdruid/python-wayback-machine-downloader, Owez/yark, skynet0x01/tugarecon |
| Reads local files or a list, not one target | aydinnyunus/exifLooter, ianare/exif-py, vstinner/hachoir, franckferman/MetaDetective, keraattin/EmailAnalyzer, deckflow/deckprobe, blechschmidt/massdns, AlephNullSK/dnsgen, rotemreiss/uddup, utkusen/urlhunter |
| Broken upstream or its services are gone | funilrys/PyFunceble (crashes at start-up, found by the scan), UndeadSec/SwaggerSpy, HowToFind-bot/YaSeeker, dhn/udon, tanaikech/goris, dievus/msdorkdump, xenova/chat-downloader, krishpranav/vesper |
| Needs Tor, Selenium or an AI service, or isn't a CLI | apurvsinghgautam/robin, z0m31en7/Uscrapper, MikeMeliz/TorCrawl.py, Oldcircle/geo-sleuth, OSINT-TECHNOLOGIES/dpulse, LayeredStudio/whoiser, tasos-py/Search-Engines-Scraper, ninoseki/mihari, 0xsha/CloudBrute, ninoseki/miteru, wimpysworld/ia-get |

Health risks for these, beyond the general ones below:

| Package | Risk |
| --- | --- |
| `asnmap`, `geointel`, `greynoise` | Need a key; the test expects the exit code the source gives without one (1, 1 and 255), read from the code, not seen |
| `youtube-transcript-api`, `ddgr`, `x-tweet-fetcher` | YouTube, DuckDuckGo and FxTwitter may block cloud IPs |
| `gowitness` | Runs Chromium inside ot's sandbox (1 GB, 256 processes, read-only root); arm64 Chromium on Alpine not confirmed |
| `photon`, `indicator-intelligence`, `dnsanity`, `nerva`, `urx` | Unusual base images: Python 3.10 (photon's regex breaks on 3.11+), Python 3.11, Go 1.27 and Rust 1.98 as upstream requires |
| `pywhat`, `linx`, `goverview` | Old pinned dependencies (2021–2022) that may not build today |
| `cut-cdn`, `favirecon`, `dnsanity` | Print nothing for their test input when nothing matches; that is a pass (exit 0) |
| `shuffledns`, `puredns` | Bundle a 5,000-word list and eight public resolvers; brute-forcing contacts the target's name servers |

## PyPI clients of data providers (October 2026)

25 more packages come from a second pass on 24 Oct 2026, over PyPI rather than GitHub stars. It looked for the client
packages that data providers useful in OSINT, or their users, publish there, which the survey above had screened out
as libraries. 147 packages were read at their latest release (wheel, entry points and command-line source), with their
licence file and, where possible, a live call to the provider. Every one and its outcome is in
[`candidates.md`](candidates.md).

All 25 were published on 24 Oct 2026, at the owner's request without the outreach step:
- Each repository was created between 16:53 and 16:56 UTC with one commit, as the October ones were.
- The 11 pipx wrappers were tagged, and the release workflow ran for the 14 Docker builds.
- Every release was published by 17:04 UTC.

- A package with **its own command** became a community wrapper that runs it unmodified. That is a pipx wrapper when
  the wheel and its console script are enough. It is a Docker wrapper when the command needs:
  - an extra the wheel leaves out (`onyphe`);
  - a newer Python than the pipx sandbox's 3.12 (`gleif`);
  - or its key in a file (`malwarebazaar`, `ipdata`, `safebrowsing`): a shim writes it from the key's environment
    variable into the container's temporary home folder, as `shodan-host` does.
- A **library** from one of the big providers became a first-party tool built on its official client.
  - The client is pinned in `requirements.txt`, so the build watcher follows its releases.
  - The tool prints typed entities like the other first-party tools, and has unit tests with the client mocked.
  - A missing key exits with code 3, as `shodan-host` does.
- The publish scan runs the test without secrets, so a tool that needs a key has a test that expects its exit code
  without one.
- Providers that need a paid plan are included, with the key marked `pricing: paid` (`fofa`, `handelsregister`,
  `hibp-breaches`).

Unlike the October batch, every tool was run before release, on Windows with Python 3.13 (the sandbox is Linux with
3.12):
- Each pinned wheel was installed from PyPI with its hash checked.
- Each test command, built from `test.input` the way `ops/scanner/scan.py` builds it, ran with no keys, an empty home
  folder and stdin closed.

Every exit code matched `expect_exit_code`, and the keyless tools returned real results. The runs changed these before
release:

| Package | Found | Change |
| --- | --- | --- |
| `onyphe`, `malwarebazaar` | The commands import Typer and Rich, which only the packages' `cli` extra installs | Docker images that install `pyonyphe[cli]` and `malwarebazaar[cli]`; `onyphe` was planned as a pipx wrapper |
| `cdx-toolkit` | `cdxt` crashes without `--cc`, `--crawl` or `--ia`, and Common Crawl's index answered 502 and 504 when asked about a year of crawls | Searches the latest crawl (`--crawl 1`) unless `crawls` says more |
| `ia-search`, `cdx-toolkit`, `gleif` | The scanner's smoke command leaves out input defaults, so an argument such as `rows:{limit}` would lose its value | The test inputs give those inputs explicitly |
| `joe-sandbox` | Without a key the API answers error 4, so the CLI exits 104 (100 plus the code) | `expect_exit_code: 104` |
| `savepagenow` | Save Page Now answered HTTP 429 to a second anonymous capture within minutes | No `test`, so the smoke test is skipped; every run would also leave a public capture |
| `hashlookup` | On Windows the CLI builds its URLs with backslashes | None: containers run Linux. The README warns about `ot run --native` on Windows |
| `ipinfo`, `companies-house` | A script named like its client library (`ipinfo.py`, `companies_house.py`) would import itself | Scripts named `ipinfo_lookup.py` and `companies_house_lookup.py` |

None of the tools that need a key was run with one. `sec-edgar` was not run live either: it needs a personal EDGAR
identity (a name and email address the SEC asks for).

The registry's scans at release agreed with the local runs:
- **Smoke tests.** Each one passed with the expected exit code; `savepagenow`'s was skipped.
- **Docker builds.** The release workflows were the images' first builds, and all 14 built for amd64 and arm64.
- **Signatures and provenance.** Every image's cosign signature passes. The six pipx wheels with PEP 740 attestations
  (`handelsregister`, `hashlookup`, `phishtank-lookup`, `lookyloo`, `ia-search`, `cdx-toolkit`) pass provenance
  against the `homepage` repository; `cdx-toolkit`'s is `commoncrawl/cdx_toolkit`, which PyPI's own homepage link
  doesn't show. The other five have no attestations and get "warn".
- **Vulnerabilities.** Only `gleif` warns, with 4 fixable high-severity vulnerabilities in its `python:3.13-slim`
  image.

| Package | Version | License | Upstream | Runtime | Inputs | Categories |
| --- | --- | --- | --- | --- | --- | --- |
| `osintverse-community/onyphe` | 3.1.1 | MIT | onyphe/pyonyphe | Docker, PyPI release with its `cli` extra | `ip` (ip) | ip-network |
| `osintverse-community/polyswarm` | 4.7.0 | MIT | polyswarm/polyswarm-cli | pipx (PyPI wheel) | `hash` (hash) | utilities |
| `osintverse-community/joe-sandbox` | 3.25.0 | MIT | joesecurity/jbxapi | pipx (PyPI wheel) | `hash` (hash)?, `url` (url)?, `domain` (domain)? | utilities, domain-dns |
| `osintverse-community/fofa` | 2.0.3 | MIT | fofapro/fofa-py | pipx (PyPI wheel) | `ip` (ip)?, `domain` (domain)? | ip-network, domain-dns |
| `osintverse-community/handelsregister` | 0.9.0 | AGPL-3.0 | Handelsregister-AI/handelsregister | pipx (PyPI wheel) | `company` (company) | company, people |
| `osintverse-community/hashlookup` | 1.2.8 | GPL-3.0 | hashlookup/PyHashlookup | pipx (PyPI wheel) | `hash` (hash) | utilities, documents-metadata |
| `osintverse-community/phishtank-lookup` | 1.6.0 | BSD-3-Clause | Lookyloo/PyPhishtankLookup | pipx (PyPI wheel) | `url` (url) | domain-dns, utilities |
| `osintverse-community/bgpranking` | 2.0.2 | BSD-3-Clause | D4-project/pybgpranking | pipx (PyPI wheel) | `asn` (string) | ip-network |
| `osintverse-community/lookyloo` | 1.43.0 | BSD-3-Clause | Lookyloo/PyLookyloo | pipx (PyPI wheel) | `domain` (domain) | domain-dns, web-archive |
| `osintverse-community/ia-search` | 5.12.1 | AGPL-3.0 | jjjake/internetarchive | pipx (PyPI wheel) | `query` (string), `limit` (integer)? | web-archive, documents-metadata |
| `osintverse-community/cdx-toolkit` | 0.9.39 | Apache-2.0 | commoncrawl/cdx_toolkit | pipx (PyPI wheel) | `domain` (domain), `crawls` (integer)?, `limit` (integer)? | web-archive, domain-dns |
| `osintverse-community/savepagenow` | 1.3.1 | MIT | palewire/savepagenow | pipx (PyPI wheel) | `url` (url) | web-archive |
| `osintverse-community/gleif` | 2026.7.3 | MIT | ggravlingen/pygleif | Docker, PyPI release on Python 3.13 | `company` (company), `limit` (integer)? | company |
| `osintverse-community/malwarebazaar` | 0.2.9 | MIT | 3c7/bazaar | Docker, shim around the PyPI release | `hash` (hash) | utilities |
| `osintverse-community/ipdata` | 4.0.9 | MIT | ipdata/python | Docker, shim around the PyPI release | `ip` (ip) | ip-network |
| `osintverse-community/safebrowsing` | 0.1.4 | MIT | Te-k/pysafebrowsing | Docker, shim around the PyPI release | `url` (url) | domain-dns, utilities |

The first-party tools, all version 0.1.0:

| Package | Built on | Key | Inputs | Categories |
| --- | --- | --- | --- | --- |
| `osintverse-community/virustotal` | vt-py 0.22.0 (VirusTotal) | `VIRUSTOTAL_API_KEY` (free tier) | one of `ip`, `domain`, `url`, `hash` | ip-network, domain-dns, utilities |
| `osintverse-community/urlscan-search` | urlscan-python 2026.8.18 (urlscan.io) | `URLSCAN_API_KEY`, optional | one of `domain`, `ip`, `url`, `query`; `limit`? | domain-dns, ip-network, web-archive |
| `osintverse-community/censys-host` | censys-platform 0.16.5 (Censys Platform) | `CENSYS_API_TOKEN` (free tier); `CENSYS_ORG_ID`, optional | `ip` | ip-network, domain-dns |
| `osintverse-community/otx-indicators` | OTXv2 1.5.12 (AlienVault OTX) | `OTX_API_KEY`, optional | one of `ip`, `domain`, `url`, `hash` | ip-network, domain-dns, utilities |
| `osintverse-community/ipinfo` | ipinfo 5.6.0 (IPinfo) | `IPINFO_TOKEN`, optional | `ip` | ip-network |
| `osintverse-community/hunter-domain-search` | pyhunter 2.1.0 (Hunter) | `HUNTER_API_KEY` (free tier) | `domain`, `limit`? | email, company, people |
| `osintverse-community/hibp-breaches` | pyhibp 4.2.0 (Have I Been Pwned) | `HIBP_API_KEY` (paid) | `email` | breach-data, email |
| `osintverse-community/companies-house` | companies-house 0.2.1 (Companies House) | `COMPANIES_HOUSE_API_KEY` (free) | `company` or `number`; `limit`? | company, people |
| `osintverse-community/sec-edgar` | edgartools 5.62.1 (SEC EDGAR) | `EDGAR_IDENTITY` (a name and email address) | `company`, `limit`?, `filings`? | company, documents-metadata |

pyhibp is AGPL-3.0-or-later. `hibp-breaches`' own script is MIT, and its image installs pyhibp unmodified from PyPI, as
the wrappers of AGPL tools do.

Dropped after reading the package (each reason is in [`candidates.md`](candidates.md)):

| Reason | Packages |
| --- | --- |
| The provider's API or service is gone | censys (Censys switched Legacy Search off on 30 Sep 2026; `censys-host` uses the Platform API), pybinaryedge, spyse-python, bgpview-client, proxycurl-py, clearbit, passivetotal, inquestlabs, google-api-python-client (Custom Search), etherscan-python (Etherscan V1), pwnedapi and hibp (HIBP v2), alephclient |
| Licence | netlas (its LICENSE.md is CC-BY-NC-ND-4.0), python-abuseipdb (WTFPL), SilentPushCLI (proprietary), and no licence file: pyipasnhistory, dnsdumpster, fullhunt-api, numlookupapi, ch-api, etherscan-v2 |
| Acceptable use: leaked data | intelx |
| Prompts, needs a login, or is broken or unsafe | aionyphe, truecallerpy, Telethon, toot, wigle, pypssl, pypdns, threatfox, urlscanio and domaintools_api (TLS verification off), urlscan-py, emailrep, hibpcli, abuseipdb-wrapper, robtex-python, falcon-sandbox, brave-search-python-client, ddgs, zoomeye, zoomeyeai, hunter-how-cli, pysecuritytrails, cymruwhois, ripe.stat.cli, archiveis, archivenow, blockstream, pymempool |
| Not a lookup | ripe.atlas.tools (network measurements), gglsbl (a local copy of the lists), pyalienvaultcli (adds to OTX pulses), sec-edgar-downloader, secedgar and bdfr (download into a folder) |
| Needs Python 3.14 or later | otxcli, greynoisecli, viewdns, filescancli, hybridanalysis, netlascli |
| A library with no command, not built into a tool this time | leakix, ip2location-io, whois-api, pulsedive, criminalip, maltiverse, peopledatalabs, rocketreach, twilio, praw, atproto, Mastodon.py, serpapi, blockcypher and more |

Providers with no usable PyPI client at all (AbuseIPDB, Shodan InternetDB, HackerTarget, URLhaus, Pulsedive,
OpenSanctions) became first-party tools over plain HTTP: see "Data providers without a PyPI client" below.

Health risks for these:

| Package | Risk |
| --- | --- |
| `onyphe`, `polyswarm`, `joe-sandbox`, `fofa`, `handelsregister`, `malwarebazaar`, `ipdata`, `safebrowsing` | Need a key, so the test expects the exit code without one (2, 2, 104, 1, 1, 3, 3 and 3, seen in the local runs); the smoke test can't tell whether lookups still work |
| `virustotal`, `censys-host`, `hunter-domain-search`, `hibp-breaches`, `companies-house`, `sec-edgar` | The same, with exit code 3 |
| `lookyloo`, `phishtank-lookup`, `bgpranking`, `hashlookup` | CIRCL's public services; when Lookyloo's instance is down the CLI prints a message and still exits 0 |
| `cdx-toolkit` | Common Crawl's index is often overloaded and can block an address for a day after heavy use |
| `urlscan-search`, `otx-indicators`, `ipinfo`, `ia-search` | Anonymous rate limits, shared by everything on a CI runner's address |
| `savepagenow` | No smoke test |
| `fofa`, `handelsregister`, `hibp-breaches` | Need a paid plan |
| `gleif` | Its scan warns about 4 fixable high-severity vulnerabilities in the image |

## Data providers without a PyPI client (October 2026)

Six providers that the PyPI pass found useful but without a usable client became first-party tools on 24 Oct 2026.
Each calls the provider's HTTP API with Python's standard library alone, so it has no `requirements.txt` and the
build watcher has nothing to follow but its base image. Otherwise they follow the other first-party tools:
- typed entities;
- unit tests with the network mocked;
- exit code 3 when a required key is missing;
- `pricing` on every key.

None was dropped. Each provider's terms allow a client that a person runs for themselves, with their own key where
one is needed, though some keep their free use to non-commercial use, which each README says.

All six were published on 24 Oct 2026, at the owner's request without the outreach step:
- Each repository was created between 19:25 and 19:26 UTC with one commit, "Add <name>", as the PyPI pass's were.
- The release workflow ran for each, for amd64 and arm64.
- Every release was published by 19:29 UTC.

| Package | API | Key | Inputs | Categories |
| --- | --- | --- | --- | --- |
| `osintverse-community/shodan-internetdb` | Shodan InternetDB | none | `ip` | ip-network |
| `osintverse-community/hackertarget` | HackerTarget's host search, DNS, reverse DNS, AS and reverse IP lookups | `HACKERTARGET_API_KEY`, optional (paid) | one of `domain`, `ip` | domain-dns, ip-network |
| `osintverse-community/abuseipdb` | AbuseIPDB v2 `check` | `ABUSEIPDB_API_KEY` (free tier) | `ip`, `days`? | ip-network |
| `osintverse-community/urlhaus` | abuse.ch URLhaus v1 `url`, `host` and `payload` | `ABUSECH_AUTH_KEY` (free, shared with `malwarebazaar`) | one of `url`, `domain`, `ip`, `hash` | domain-dns, ip-network, utilities |
| `osintverse-community/pulsedive` | Pulsedive `indicator.php` | `PULSEDIVE_API_KEY`, optional (free tier) | one of `ip`, `domain`, `url` | ip-network, domain-dns, utilities |
| `osintverse-community/opensanctions` | OpenSanctions `/match/default` | `OPENSANCTIONS_API_KEY` (paid) | `name` or `company`; `birth_date`?, `country`?, `limit`? | people, company |

What the providers' terms and APIs led to:

- **Shodan InternetDB** needs no key and is free for non-commercial use; Shodan asks commercial users for an
  enterprise license.
- **HackerTarget** allows 50 free API calls a day from one address, but only about 20 for the host search, reverse IP
  and reverse DNS lookups (its `X-API-Quota` header), and cuts free results at 500 lines. A run makes two calls for a
  domain and three for an address. The tool uses only lookups that send the target nothing but DNS queries:
  - its port scans, traceroute, ping, zone transfer, HTTP headers, page links and banner tools are left out, and its
    terms allow scanning only systems you own;
  - `whois` now needs a membership key, so it is left out too.
- **AbuseIPDB**'s free plan allows 1,000 checks a day, and its terms keep it to non-commercial use.
- **abuse.ch**'s terms make URLhaus free for not-for-profit use; commercial users may need a subscription through
  Spamhaus.
- **Pulsedive** answers without a key, at about 10 lookups a day from one address (its `X-Requests-Remaining-Day`
  header); a free account's key raises that.
  - Its terms of service forbid robots and other automated access in general words, but Pulsedive documents the API
    for programs, with keys and a list of community client libraries; the tool uses only that API.
  - It only reads existing records: `analyze.php` would scan the target.
- **OpenSanctions**' hosted API is not free for non-commercial use in general, so its key is `pricing: paid`.
  - Businesses pay per query after trial credits; free keys go only to journalists, NGOs and academic researchers who
    apply.
  - Its data is CC BY-NC 4.0.
  - Matches describe people, so the manifest sets `collects_personal_data` and a note for consent prompts.

Every tool was run before release, on Windows with Python 3.13 (the sandbox is Linux with 3.12):
- its unit tests and `ot validate`;
- the test command built from `test.input` the way `ops/scanner/scan.py` builds it, with no keys, an empty home
  folder and stdin closed.

Every exit code matched `expect_exit_code`, and the keyless tools returned real results: InternetDB and Pulsedive for
8.8.8.8, HackerTarget for otinstaller.com. With a made-up key, AbuseIPDB, URLhaus, OpenSanctions and Pulsedive refused
it, and each tool exited 1 with the provider's message. None was run with a real key. HackerTarget's IP lookups were
written against their live answers, but a full `--ip` run used up the day's free allowance and exited 1 with the
"API count exceeded" message instead. Calling the live APIs while the tools were written, and the runs, found these:

| Package | Found | Change |
| --- | --- | --- |
| `hackertarget` | `output=json` works only for some lookups (the others answer 400 with the text in `error`), and errors come as plain text with status 200 (`error invalid host`, `API count exceeded`) | Reads plain text and treats those lines as errors |
| `hackertarget` | The free allowance for host search, reverse IP and reverse DNS is about 20 calls a day, not 50 | The README and the key's description say so |
| `pulsedive` | Some properties come with a `++` prefix, alone (`++title`) or beside the plain one (`cidr` and `++cidr`) | The tool reads either and merges DNS records from both |
| `pulsedive` | Records carry comments anyone can post (some are injection attempts) and WHOIS contacts | Both are left out |

The registry's scans at release agreed with the local runs:
- **Smoke tests.** `shodan-internetdb`, `hackertarget` and `pulsedive` exited 0 with results from the scan runner (3,
  25 and 12 entities), which their tool pages show as sample output; `abuseipdb`, `urlhaus` and `opensanctions`
  exited 3 without a key.
- **Signatures.** Every image's cosign signature passes.
- **Vulnerabilities.** None is fixable at critical or high. The 44 high-severity ones without a fix are in the
  `python:3.12-slim` base, as in the other first-party tools.

The release workflow was started a second time in each repository, two minutes after the first. Those runs rebuilt the
image, pushed a second "Release 0.1.0" commit to `main` pinning the new digest, and then failed because the tag
`v0.1.0` already existed. The registry published from the tag, so it pins the first build, and at 19:40 UTC each
repository's `main` was put back on the tag, dropping the extra commit. GHCR's `0.1.0` tag still names the second
build, which the same workflow signed; installs pull by digest, so nothing uses it. Run the release workflow once per
version.

Health risks for these:

| Package | Risk |
| --- | --- |
| `abuseipdb`, `urlhaus`, `opensanctions` | Need a key, so the test expects exit code 3; the smoke test can't tell whether lookups still work |
| `hackertarget`, `pulsedive`, `shodan-internetdb` | Anonymous limits, shared by everything on a CI runner's address: about 20 HackerTarget host searches a day (a run uses one, plus a DNS lookup), about 10 Pulsedive lookups a day, and InternetDB's undocumented rate limit |
| `opensanctions` | Needs a paid plan, or a free key for journalists, NGOs and researchers |

## How each part gets published

Order matters: namespaces first, then tools, then guides (a guide's `related_tools` must already be published).
The step-by-step runbook with commands is in the session notes (`seeding.md`); in short:

1. **Namespace.** Everything publishes under the `osintverse-community` GitHub organisation (approved and verified on
   the registry), first-party tools and guides included.
2. **First-party tools.** Create `osintverse-community/<name>` for each folder in `first-party/`, push its contents, run the
   **otinstaller release** workflow with `0.1.0`. The workflow builds, signs and pins the image and tags.
3. **Third-party tools: outreach first.** For each upstream, post the outreach issue and, if the maintainer is
   interested, open the outreach pull request (both texts are kept with the launch material) with the manifest from `community/<name>/`
   adapted to their namespace. If they publish it themselves, drop the wrapper.
4. **Community wrappers** after 14 days without an answer. Either run the import wizard with `community: true` and
   finish in wrapper mode, or create `osintverse-community/<name>`, push the folder and tag `v<version>` (pipx) or run
   the release workflow (Docker). The package is labelled Community-packaged, and the upstream maintainer can
   `ot claim` it.
5. **Guides.** Create `osintverse-community/<name>` for each folder in `guides/`, push, run the release workflow with `1.0.0`.

## Checked so far

- `ot validate` passes for all 48 launch manifests, and `TestSeedManifests` passes for all 156 in `seed/`.
- The 25 packages from the PyPI pass were run before release; "PyPI clients of data providers" above says how and
  what the runs changed. The 9 first-party tools' unit tests pass.
- The 6 first-party tools over HTTP were run before release and their unit tests pass; "Data providers without a
  PyPI client" above says how, and what the registry's scans said when they were published.
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
cloud servers to its login page, so the scan's smoke test can never pass.

## Health risks to watch after publishing

The exit criterion is that every seeded package passes its scan's smoke test, which runs each tool's `test.input`
from GitHub Actions runners, and that nobody reports it broken (a package's health comes from what people report).
Expect trouble from:

| Package | Risk | If it fails |
| --- | --- | --- |
| `osintverse-community/shodan-host` | Needs `SHODAN_API_KEY`; the scan passes no secrets | The test expects exit code 3 without a key, so only people's reports show whether lookups work |
| `osintverse-community/yt-dlp` | YouTube blocks cloud IPs ("Sign in to confirm") | The test input is an Internet Archive video; YouTube URLs still work for most users |
| `osintverse-community/crtsh-subdomains` | crt.sh is often down | Falls back to Cert Spotter (limited to a few lookups an hour without a key) |
| `osintverse-community/maigret`, `naminter`, `mailcat` | Not run end to end here | Run `ot validate --smoke` after the first release |

## Updating a wrapper

Change `version` (and for pipx wrappers `package_version` and `wheel_sha256`, from
`https://pypi.org/pypi/<package>/json`), then tag, or run the release workflow for Docker wrappers.

The upstream watcher (`api/src/upstream.ts`) checks every wrapper nightly against its project's latest release, from
the pin in its Dockerfile (`api/src/upstream-pin.ts` reads `go install …@v1.2.3`, `pip install tool==1.2.3`,
`git+…@ref`, `git checkout`, `cargo install --tag`, release and raw URLs, or `ARG UPSTREAM_VERSION`). Every Dockerfile
here parses, which `api/test/upstream.test.ts` checks. With `UPSTREAM_WATCH=issues` a wrapper behind a release gets an
outdated issue; with `prs` the community bot also opens a pull request that changes only the pin, and the package's
maintainers merge and release it from its page. Keep pins on one line so a bump stays a one-line change.

## notifies_target and key pricing (22 Oct 2026)

Seven published packages gained the optional fields agents read (`ethics.notifies_target` and `ethics.notes`, or a
key's `pricing`) after their first release, and were re-released with them on 22 Oct 2026: dnsrecon 1.6.4, httpx
1.12.1, tlsx 1.4.1, holehe 1.61.1 and shodan-host 1.31.1 (community), exif-meta 0.1.1 and image-hash 0.1.1
(first-party). The community wrappers already pinned the latest upstream release, so their re-releases take a patch
bump that upstream never shipped; the Dockerfile still pins the same upstream version. fierce and finalrecon have the
fields too but have never been published (see "Converted from the otinstaller catalog").

A manifest change alone can't be published under the same version: the release must bump it (Docker wrappers' release
workflow does; pipx wrappers need a `version` bump by hand).

## Longer READMEs (25 Oct 2026)

Ten of the most-searched wrappers have READMEs that say what the tool does and when to use it, how to run it with a
typed input (and with otlite where its catalog has the tool), what it returns, which keys and network it needs, and
which registry packages take the same input. The opening credit and report/claim paragraphs are unchanged. Every fact
comes from the manifest, the upstream README at the pinned release, or the public API.

- The output samples are from each version's smoke scan (`output_excerpt` in
  `GET /v1/tools/osintverse-community/<name>/<version>/scans`), because production's tool response had no `sample`
  field on 25 Oct.
- A README reaches the tool page only with a new release, so each package takes a patch version upstream never
  shipped, as in the section above.
- The pipx wrappers' `version` is bumped here (same `package_version` and `wheel_sha256`); push and tag `v<version>`.
- The Docker wrappers' manifests here keep their old `version`, because the release workflow writes the version it is
  given along with the image digest: copy only the README to their repositories and run the workflow with the new
  version. holehe's manifest here still says 1.61.0; its repository is at 1.61.1 since the re-release above.

| Package | Runtime | New version |
| --- | --- | --- |
| `sherlock` | pipx | 0.16.3 |
| `maigret` | pipx | 0.6.7 |
| `dnstwist` | pipx | 20250130.0.1 |
| `social-analyzer` | pipx | 0.45.1 |
| `socialscan` | pipx | 2.0.2 |
| `mailcat` | pipx | 0.1.2 |
| `holehe` | Docker | 1.61.2 |
| `phoneinfoga` | Docker | 2.11.1 |
| `theharvester` | Docker | 4.11.2 |
| `subfinder` | Docker | 2.17.1 |

All ten were published on 25 Oct 2026.

## Fixable vulnerabilities (25 Oct 2026)

The scans of phoneinfoga, theharvester and subfinder warned about critical or high vulnerabilities with fixed releases
(the counts were all their scans keep, so Trivy 0.76.0, the scanner's version, was run on the published images to name
them). The upstream pins are unchanged; each Dockerfile now raises the vulnerable dependencies instead:

- **phoneinfoga** is built from source at v2.11.0 with Go 1.26 instead of using upstream's release binary, which was
  built with Go 1.20, and with current golang.org/x/crypto, x/net, x/text, x/oauth2, grpc, logrus and gin. The web
  interface upstream embeds is built with Node and isn't in the repository, so a placeholder page stands in;
  `phoneinfoga scan` doesn't use it.
- **theharvester** installs aiohttp 3.14.5 and certifi 2026.10.23 after theHarvester 4.11.1, which pins 3.14.0 and
  2026.5.20.
- **subfinder** is cloned at v2.17.0 and built with klauspost/compress 1.18.7 and golang.org/x/net 0.61.0, because
  `go install …@v2.17.0` can't change dependencies.

Released as phoneinfoga 2.11.2, theharvester 4.11.3 and subfinder 2.17.2.
