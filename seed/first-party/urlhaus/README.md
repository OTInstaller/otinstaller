# urlhaus

Looks up a URL, a host (domain or IP address) or a file hash in URLhaus, abuse.ch's shared database of URLs used to spread malware. A URL comes back with whether it is listed and still online, its threat type, tags, reporter, the date it was added, its listings on Spamhaus DBL and SURBL, and the files (payloads) it served. A host comes back with how many malware URLs it had and the URLs themselves, and a file hash with the file's type, size, malware family and the URLs that served it. Only URLhaus's database is read, so the target is not contacted.

```
ot run osintverse-community/urlhaus --domain example.com
```

## Inputs

Give exactly one.

| Input | Required | |
| --- | --- | --- |
| `url` | one of these | URL, exactly as URLhaus lists it |
| `domain` | one of these | Host name: the malware URLs on it |
| `ip` | one of these | IP address: the malware URLs on it |
| `hash` | one of these | MD5 or SHA-256 of a file: the URLs that served it |

## Keys

`ABUSECH_AUTH_KEY`, set with `ot keys set ABUSECH_AUTH_KEY`: the free Auth-Key from the abuse.ch authentication portal, https://auth.abuse.ch/, which MalwareBazaar and ThreatFox use too. abuse.ch's terms make its platforms free for not-for-profit use; commercial users may need a paid subscription through Spamhaus. Without the key the tool exits with code 3.

## Notes

A target URLhaus has never listed gives no entities and a note on stderr. A host lookup matches that exact host, not its subdomains, and a URL lookup matches the URL character for character. URLhaus lists at most 100 URLs or payloads for one target. SHA-1 hashes can't be looked up; a value URLhaus rejects as invalid exits with code 2.

## Next steps

Look a payload up in [osintverse-community/malwarebazaar](https://otinstaller.com/osintverse-community/malwarebazaar) or [osintverse-community/virustotal](https://otinstaller.com/osintverse-community/virustotal), or check a host's other reports with [osintverse-community/otx-indicators](https://otinstaller.com/osintverse-community/otx-indicators).

## Development

```
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
