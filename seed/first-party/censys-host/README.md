# censys-host

Shows what Censys has seen on an IP address: each open port with its service, transport and the software Censys recognised, the network that announces the address and its owner, its location, the host names that point at it, and the labels Censys gives the host. Uses Censys's official Python client for the Censys Platform API, which replaced Censys Search when Censys switched the legacy API off on 30 September 2026. Censys scans the internet on its own schedule; this only reads what it has, so the target is not contacted.

```
ot run osintverse-community/censys-host --ip 8.8.8.8
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `ip` | yes |  |

## Keys

`CENSYS_API_TOKEN`, set with `ot keys set CENSYS_API_TOKEN`: a personal access token from https://accounts.censys.io/settings/personal-access-tokens. Free accounts get a monthly allowance of credits, and each lookup spends some. `CENSYS_ORG_ID` is optional: set it to spend your organisation's credits instead. Without the token the tool exits with code 3.

## Notes

An address Censys has no record of gives no entities and a note on stderr. Host names come from forward and reverse DNS as Censys last saw them; the tool lists at most 50.

## Next steps

Look the address up in [osintverse-community/virustotal](https://otinstaller.com/osintverse-community/virustotal) or [osintverse-community/greynoise](https://otinstaller.com/osintverse-community/greynoise), and resolve the host names with [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records).

## Development

```
pip install censys-platform==0.16.5
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
