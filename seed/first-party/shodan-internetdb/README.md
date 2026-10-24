# shodan-internetdb

Looks up an IP address in Shodan's InternetDB, a free summary of what Shodan's internet-wide scans last saw on an address: its open ports, the host names pointing at it, the software it runs (as CPEs), tags such as `cdn`, `vpn` or `self-signed`, and the known vulnerabilities (CVEs) that software has. No key or account is needed. Only Shodan's database is read, so the target is not contacted.

```
ot run osintverse-community/shodan-internetdb --ip 8.8.8.8
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `ip` | yes | IPv4 or IPv6 address |

## Keys

None. InternetDB is free for non-commercial use; Shodan asks anyone using it to make money to buy an enterprise license.

## Notes

InternetDB is updated about once a week and keeps no banners or history, so a port may have closed since. The CVEs are inferred from software versions, not tested, and a patched build that keeps its version number still shows them. An address Shodan has no information on, and a private or reserved address, give no entities and a note on stderr.

## Next steps

See the services' banners and history with [osintverse-community/shodan-host](https://otinstaller.com/osintverse-community/shodan-host) (needs a Shodan key), or check the address's reputation with [osintverse-community/abuseipdb](https://otinstaller.com/osintverse-community/abuseipdb).

## Development

```
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
