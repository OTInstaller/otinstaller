# Subdomains

Subdomains show what an organisation runs: staging sites, VPN gateways, regional shops, forgotten marketing pages.

## Certificate Transparency

Every publicly trusted TLS certificate is logged. Any name that ever had one is searchable:

```
ot run osintverse-community/crtsh-subdomains --domain example.com
```

Each subdomain comes with the first and last certificate dates and the issuers, so you can tell a name that has
existed for years from one created last month.

## Passive sources

```
ot run osintverse-community/subfinder --domain example.com
```

subfinder combines dozens of sources: passive DNS datasets, search engines, archives and certificate logs. Some
sources work better with free API keys; see the tool's page.

## Making sense of the list

- Merge both lists and remove duplicates.
- Resolve them with `osintverse-community/dns-records` to see which still exist. Old names stay in the logs long after they
  stop resolving, and those are history, not attack surface.
- Group names by pattern (`dev-`, `staging.`, `vpn.`, country codes). Patterns tell you how the organisation names
  things, which helps you guess names no source has seen.

Next: [history](04-history.md).
