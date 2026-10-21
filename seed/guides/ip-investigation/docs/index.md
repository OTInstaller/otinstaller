# IP investigation playbook

An IP address from a log, an email header or a DNS record tells you who operates the network, what the machine
exposes, and what else runs next to it. This playbook stays passive: nothing here scans the address.

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [Who holds the address](02-ownership.md)
3. [What it exposes](03-exposure.md)
4. [Ranges and neighbours](04-ranges.md)

**Tools used** (`ot guide tools osintverse-community/ip-investigation`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/ipwhois](https://otinstaller.com/osintverse-community/ipwhois) | RDAP: network, ASN, organisation, abuse contact |
| [osintverse-community/cdncheck](https://otinstaller.com/osintverse-community/cdncheck) | Is it a CDN, cloud provider or WAF? |
| [osintverse-community/naabu](https://otinstaller.com/osintverse-community/naabu) | Known open ports, from Shodan InternetDB (passive) |
| [osintverse-community/shodan-host](https://otinstaller.com/osintverse-community/shodan-host) | Services, banners and history (needs a Shodan key) |
| [osintverse-community/mapcidr](https://otinstaller.com/osintverse-community/mapcidr) | Expanding and counting ranges |
