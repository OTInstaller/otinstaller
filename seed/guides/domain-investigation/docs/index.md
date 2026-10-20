# Domain investigation playbook

A domain is a public record with a long memory: DNS, TLS certificates and web archives show what an organisation
runs, what it ran in the past, and who it shares infrastructure with. Everything in this playbook is passive except
the last optional step, which visits the domain's own web servers.

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [DNS records](02-dns.md)
3. [Subdomains from certificates and passive sources](03-subdomains.md)
4. [History: archived URLs and old captures](04-history.md)
5. [Look-alike domains](05-lookalikes.md)
6. [Live hosts (active)](06-live-hosts.md)

**Tools used** (`ot guide tools osintverse-community/domain-investigation`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records) | A, MX, NS, TXT and other records |
| [osintverse-community/crtsh-subdomains](https://otinstaller.com/osintverse-community/crtsh-subdomains) | Names from Certificate Transparency |
| [osintverse-community/subfinder](https://otinstaller.com/osintverse-community/subfinder) | Subdomains from dozens of passive sources |
| [osintverse-community/gau](https://otinstaller.com/osintverse-community/gau) | Every archived URL of the domain |
| [osintverse-community/waybackpy](https://otinstaller.com/osintverse-community/waybackpy) | The oldest and newest captures |
| [osintverse-community/dnstwist](https://otinstaller.com/osintverse-community/dnstwist) | Registered look-alike domains |
| [osintverse-community/httpx](https://otinstaller.com/osintverse-community/httpx) | What the live web servers run |
| [osintverse-community/tlsx](https://otinstaller.com/osintverse-community/tlsx) | The certificate a server presents |
| [osintverse-community/tldextract](https://otinstaller.com/osintverse-community/tldextract) | Splitting URLs into registered domain and subdomain |
