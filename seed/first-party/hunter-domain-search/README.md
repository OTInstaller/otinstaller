# hunter-domain-search

Lists the email addresses Hunter has found for a domain. Each address comes with its owner's name, position, department and seniority, whether it is a personal or generic address, Hunter's confidence score and verification status, any LinkedIn, X or phone details Hunter has, and the pages it was seen on. The organisation behind the domain is reported with its usual address pattern (such as `{first}.{last}`). Uses the pyhunter client for Hunter's API. Only Hunter's database is read, so nobody at the domain is contacted.

```
ot run osintverse-community/hunter-domain-search --domain example.com
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `domain` | yes |  |
| `limit` | no | Most addresses to return: 10 by default, which is what free plans get; paid plans allow up to 100 |

## Keys

`HUNTER_API_KEY`, set with `ot keys set HUNTER_API_KEY`. A free Hunter account includes a monthly allowance of searches: https://hunter.io/api-keys. Without the key the tool exits with code 3.

## Notes

The results are people's work addresses, so `ot` and agents treat a run as collecting personal data and ask before running it. Hunter's confidence score becomes the entity's confidence: high from 90, medium from 50.

## Next steps

Check an address with [osintverse-community/holehe](https://otinstaller.com/osintverse-community/holehe), or look the organisation up in [osintverse-community/companies-house](https://otinstaller.com/osintverse-community/companies-house) or [osintverse-community/gleif](https://otinstaller.com/osintverse-community/gleif).

## Development

```
pip install pyhunter==2.1.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
