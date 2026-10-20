# DNS records

```
ot run osintverse-community/dns-records --domain example.com --format table
```

| Record | What it tells you |
| --- | --- |
| `A` / `AAAA` | Where the website is hosted. Look the IPs up with the [IP playbook](https://otinstaller.com/guides/osintverse-community/ip-investigation). A CDN address (Cloudflare, Fastly, Akamai) hides the real server. |
| `NS` | Who runs the DNS. Registrar defaults, a CDN, or the organisation's own servers. |
| `MX` | Who handles email: Google, Microsoft, a security gateway, or self-hosted. |
| `TXT` | SPF (which systems send mail for the domain) and verification tokens for services the organisation uses. |
| `CAA` | Which certificate authorities may issue for the domain. |
| `SOA` | The primary name server and, sometimes, a contact address. |

For the email side (SPF, DMARC, BIMI) in detail, run
[osintverse-community/checkdmarc](https://otinstaller.com/osintverse-community/checkdmarc).

To split a messy list of URLs into their registered domains and subdomains:

```
ot run osintverse-community/tldextract --url "https://forums.news.example.co.uk/thread/1"
```

Next: [subdomains](03-subdomains.md).
