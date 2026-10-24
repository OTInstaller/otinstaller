# pulsedive

Looks up an IP address, domain or URL in Pulsedive, a community threat intelligence platform that gathers indicators from public threat feeds and its own scans. It gives Pulsedive's risk level (none to critical) and the risk factors behind it, the threats (malware families, campaigns, adversaries) and feeds that list the indicator, and what Pulsedive's past scans saw: open ports, protocols, technologies, page title, DNS records, redirects, network owner and location. Only Pulsedive's existing record is read: nothing is submitted for a new scan, so the target is not contacted.

```
ot run osintverse-community/pulsedive --domain example.com
```

## Inputs

Give exactly one.

| Input | Required | |
| --- | --- | --- |
| `ip` | one of these | IP address |
| `domain` | one of these | Domain |
| `url` | one of these | URL |

## Keys

None needed: lookups without a key work at a low limit (about 10 a day from one address). `PULSEDIVE_API_KEY` (`ot keys set PULSEDIVE_API_KEY`), from a free Pulsedive account, raises it, and paid plans raise it further: https://pulsedive.com/account. When the limit is reached the tool exits with code 1 and says so.

## Notes

An indicator Pulsedive has never seen gives no entities and a note on stderr; the tool doesn't submit it, since a new scan would contact the target. The scan data can be old: `last_scanned` says when Pulsedive last probed the indicator. Comments people left on Pulsedive and its WHOIS contact details are left out.

## Next steps

Read the threat's other indicators on its Pulsedive page (the `link` of each threat), or check the indicator in [osintverse-community/otx-indicators](https://otinstaller.com/osintverse-community/otx-indicators) and [osintverse-community/urlhaus](https://otinstaller.com/osintverse-community/urlhaus).

## Development

```
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
