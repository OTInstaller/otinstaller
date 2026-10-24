# urlscan-search

Searches urlscan.io for the scans other people already made of a domain, an IP address or a URL, or runs any urlscan.io search query. Each scanned page comes back with its address, title, HTTP status, server, IP address, network, country and TLS issuer, when it was scanned and what was submitted, with links to the scan and its screenshot; the IP addresses and host names seen are listed too. Uses urlscan.io's official Python client, urlscan-python. It never submits a new scan, so the target is not contacted.

```
ot run osintverse-community/urlscan-search --domain example.com
```

## Inputs

Give exactly one of `domain`, `ip`, `url` or `query`.

| Input | Required | |
| --- | --- | --- |
| `domain` | one of these | Scans of pages on this host name (`page.domain`) |
| `ip` | one of these | Scans of pages served from this IP address (`page.ip`) |
| `url` | one of these | Scans of this exact page (`page.url`) |
| `query` | one of these | Any urlscan.io search query, such as `page.asn:AS15169` or `domain:example.com` (pages that loaded anything from it) |
| `limit` | no | Most scans to return, 50 by default, up to 1000 |

## Keys

None needed: searches work anonymously at lower rate limits. `URLSCAN_API_KEY` (`ot keys set URLSCAN_API_KEY`), from a free urlscan.io account, raises them: https://urlscan.io/user/profile/.

## Notes

Only public scans are searched. The newest scans come first. A rate-limited search exits with code 1 and says so on stderr.

## Next steps

Look a scanned page's IP address up with [osintverse-community/virustotal](https://otinstaller.com/osintverse-community/virustotal), or check the URL against [osintverse-community/phishtank-lookup](https://otinstaller.com/osintverse-community/phishtank-lookup).

## Development

```
pip install urlscan-python==2026.8.18
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
