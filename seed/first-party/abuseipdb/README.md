# abuseipdb

Checks an IP address in AbuseIPDB, where system administrators report addresses that attack their servers. It gives AbuseIPDB's abuse confidence score (0 to 100), how many reports and distinct reporters the address had in a period and what they reported it for (brute force, port scans, spam and so on), the ten latest reports with their comments, and AbuseIPDB's data on the address's network: ISP, usage type (such as data center or mobile), the operator's domain, reverse DNS names, country, and whether it is a Tor exit node. Only AbuseIPDB's reports are read, so the target is not contacted.

```
ot run osintverse-community/abuseipdb --ip 8.8.8.8
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `ip` | yes | IPv4 or IPv6 address |
| `days` | no | Count only reports from this many days back, 90 by default, up to 365 |

## Keys

`ABUSEIPDB_API_KEY`, set with `ot keys set ABUSEIPDB_API_KEY`. A free AbuseIPDB account's key allows 1,000 checks a day; AbuseIPDB's terms keep the free plan to non-commercial use, and paid plans cover the rest: https://www.abuseipdb.com/account/api. Without the key the tool exits with code 3.

## Notes

The score is AbuseIPDB's own estimate of how likely the address is to be abusive, worked out from its reports and reporters; an address with no reports scores 0, which says nothing about whether it is safe. Report comments are written by the reporters and are shown as they wrote them, cut to 300 characters. A private or reserved address gives no entities and a note on stderr.

## Next steps

See what runs on the address with [osintverse-community/shodan-internetdb](https://otinstaller.com/osintverse-community/shodan-internetdb), or check it in more threat feeds with [osintverse-community/pulsedive](https://otinstaller.com/osintverse-community/pulsedive) and [osintverse-community/otx-indicators](https://otinstaller.com/osintverse-community/otx-indicators).

## Development

```
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
