# dns-records

Queries the public DNS for a domain's address, mail, name server, text, SOA and CAA records, and reports the IPs and hosts they point to. Only DNS resolvers are contacted, never the domain's own servers.

```
ot run osintverse-community/dns-records --domain example.com
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `domain` | yes |  |
| `types` | no | Comma-separated record types, such as MX,TXT |

## Notes

TXT records often reveal the services a domain uses (site verification tokens for Google, Microsoft 365, Atlassian and others) and its SPF policy, which lists the systems allowed to send its email.

## Next steps

Find subdomains with [osintverse-community/crtsh-subdomains](https://otinstaller.com/osintverse-community/crtsh-subdomains) and look up the IPs with [osintverse-community/ipwhois](https://otinstaller.com/osintverse-community/ipwhois).

## Development

```
pip install dnspython==2.9.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
