# virustotal

Looks up an IP address, domain, URL or file hash in VirusTotal and reports how many antivirus engines and URL scanners flag it, its community reputation and tags, and what VirusTotal knows around it: an IP's network owner and country, a domain's registrar and last DNS records, a URL's page title and final address, a file's names, type, size and threat label. Uses VirusTotal's official Python client, vt-py. It only reads existing reports and never submits anything, so the target is not contacted.

```
ot run osintverse-community/virustotal --domain example.com
```

## Inputs

Give exactly one.

| Input | Required | |
| --- | --- | --- |
| `ip` | one of these | IP address |
| `domain` | one of these | Domain |
| `url` | one of these | URL |
| `hash` | one of these | MD5, SHA-1 or SHA-256 of a file |

## Keys

`VIRUSTOTAL_API_KEY`, set with `ot keys set VIRUSTOTAL_API_KEY`. A free account's public API key works, within 4 lookups a minute and 500 a day, for non-commercial use: get it at https://www.virustotal.com/gui/my-apikey. Without the key the tool exits with code 3.

## Notes

A target VirusTotal has never seen gives no entities and a note on stderr. URLs are looked up exactly as given: VirusTotal treats `http://example.com` and `https://example.com/` as different URLs.

## Next steps

Check a domain's current DNS records with [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records), or look a file hash up in [osintverse-community/malwarebazaar](https://otinstaller.com/osintverse-community/malwarebazaar).

## Development

```
pip install vt-py==0.22.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
