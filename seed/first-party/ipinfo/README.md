# ipinfo

Looks up an IP address in IPinfo: its reverse DNS name, city, region and country with coordinates, time zone, the network that owns it and its ASN, and whether it is anycast. Uses IPinfo's official Python client, ipinfo. Only IPinfo's data is read, so the target is not contacted.

```
ot run osintverse-community/ipinfo --ip 8.8.8.8
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `ip` | yes | IPv4 or IPv6 address |

## Keys

None needed: lookups without a token work at a lower request limit. `IPINFO_TOKEN` (`ot keys set IPINFO_TOKEN`), from a free IPinfo account, raises it: https://ipinfo.io/signup. When the limit is reached the tool exits with code 1 and says so.

## Notes

A private or reserved address (a "bogon") gives no entities and a note on stderr. The location is where IPinfo places the address, which for networks such as mobile carriers and VPNs can be far from the person using it.

## Next steps

Check the address's reputation with [osintverse-community/virustotal](https://otinstaller.com/osintverse-community/virustotal) or [osintverse-community/greynoise](https://otinstaller.com/osintverse-community/greynoise), or see its services with [osintverse-community/censys-host](https://otinstaller.com/osintverse-community/censys-host).

## Development

```
pip install ipinfo==5.6.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
