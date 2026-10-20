# crtsh-subdomains

Lists every name that appeared in a TLS certificate for a domain or its subdomains, using the public Certificate Transparency search at crt.sh (or Cert Spotter when crt.sh is down), with the first and last certificate dates and the issuers. Passive: the target is never contacted.

```
ot run osintverse-community/crtsh-subdomains --domain example.com
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `domain` | yes |  |

## Notes

Old names stay in the logs after they stop resolving, so check them with [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records). Wildcard names are reported without the `*.`. crt.sh is a free service that is often slow or down; the tool retries it and then falls back to Cert Spotter's free API, which covers fewer old certificates and is limited to a few lookups an hour without a key.

## Next steps

Resolve the names with [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
