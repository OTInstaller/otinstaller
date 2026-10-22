# Launch seed: 40 tools and 10 guides

Everything needed to seed the production registry for launch (plan week 10: "40 tools and 10 guides seeded";
exit criterion "all seeded packages healthy"). Nothing here is published or sent anywhere yet: each folder becomes
its own repository, and packages reach the registry only through the normal pipeline (tag → validation → scan or
content checks → review → published). Never seed production from `api/scripts/seed-lib.mjs` or `spec/fixtures`
(fake digests) or with SQL.

| Folder | What | Count |
| --- | --- | --- |
| [`first-party/`](first-party) | Tools written for the registry, on the result envelope, namespace `osintverse-community` | 11 |
| [`community/`](community) | Wrapper repositories for third-party tools, namespace `osintverse-community` (27 for launch, 26 published and `instaloader-profile` dropped; 11 converted from `otinstaller`; 66 open-source tools with more than 100 stars added in October 2026) | 104 |
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

## Open-source tools with more than 100 stars (October 2026)

66 more wrappers aim at breadth: every open-source OSINT tool on GitHub or GitLab with more than 100 stars that
could be wrapped. They follow the same rules as the launch wrappers (outreach first, then publish). 20 are pipx
wrappers pinned to a PyPI wheel by SHA-256 and 46 are Docker wrappers that build a pinned upstream release
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
| `osintverse-community/pyfunceble` | 4.3.1 | Apache-2.0 | funilrys/PyFunceble | pipx (PyPI wheel) | `domain` (domain) | domain-dns |
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

Not checked: none of these images was built and no wrapper was run, at the owner's request. Flags, entry points and
output formats were read from each tool's source at the pinned version, and every manifest passes
`TestSeedManifests`. The release workflow's build and the registry's scan (smoke test with `test.input`) are the first
real runs, so expect some to need a fix before they publish. Run `ot validate --smoke` after the first release.

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
| Broken upstream or its services are gone | UndeadSec/SwaggerSpy, HowToFind-bot/YaSeeker, dhn/udon, tanaikech/goris, dievus/msdorkdump, xenova/chat-downloader, krishpranav/vesper |
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

- `ot validate` passes for all 48 launch manifests, and `TestSeedManifests` passes for all 125 in `seed/`.
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

## Not yet released: notifies_target and key pricing (22 Oct 2026)

These folders gained the optional fields agents read (`ethics.notifies_target` and `ethics.notes`, or a key's
`pricing`), but their published versions don't have them yet. Each needs a new release from its own repository, which
needs the owner's go-ahead: dnsrecon, fierce, finalrecon, httpx, tlsx, holehe and shodan-host (community), exif-meta
and image-hash (first-party). Until then, agents describe the seven that touch the target (all but holehe and shodan-host)
as "may notify the target (the publisher doesn't say)". A manifest change alone can't be published under the same version: the release
must bump it (Docker wrappers' release workflow does; pipx wrappers need a `version` bump by hand).
