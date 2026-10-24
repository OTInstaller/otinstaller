# otx-indicators

Looks up an IP address, domain, URL or file hash in AlienVault OTX (Open Threat Exchange). It reports how many community threat reports ("pulses") mention the indicator and lists up to 20 of them, each with its name, tags, malware families, adversary, targeted countries, references, author and link, plus the malware families, adversaries and industries OTX relates to it, and any allow-list notes such as "Whitelisted IP". For an IP address it adds the network and location OTX has. Uses AlienVault's official Python client, OTXv2. Only OTX's own data is read, so the target is not contacted.

```
ot run osintverse-community/otx-indicators --domain example.com
```

## Inputs

Give exactly one.

| Input | Required | |
| --- | --- | --- |
| `ip` | one of these | IP address |
| `domain` | one of these | Domain or host name; a name with more than two labels is looked up as both a domain and a host name, as OTX files them apart |
| `url` | one of these | URL |
| `hash` | one of these | MD5, SHA-1 or SHA-256 of a file |

## Keys

None needed. `OTX_API_KEY` (`ot keys set OTX_API_KEY`), from a free OTX account, raises the rate limits: https://otx.alienvault.com/settings.

## Notes

Pulses are written by OTX's community. Treat their names and tags as claims to check, not verdicts: very common names such as `example.com` appear in thousands of them, which is why OTX's allow-list notes are reported too. An indicator OTX doesn't know gives no entities and a note on stderr.

## Next steps

Open a pulse's link to see every indicator it lists, or look the target up in [osintverse-community/virustotal](https://otinstaller.com/osintverse-community/virustotal).

## Development

```
pip install OTXv2==1.5.12
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
