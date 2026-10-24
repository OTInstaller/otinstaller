# hibp-breaches

Lists the data breaches an email address appears in, from Have I Been Pwned. Each breach comes with its name, the site it came from, when it happened and when HIBP added it, how many accounts it held, the kinds of data it exposed (such as email addresses or passwords), whether HIBP verified it, and a short description. Uses the pyhibp client for HIBP's API. Only breach metadata comes back, never breached data such as passwords, and the address's owner is not contacted.

```
ot run osintverse-community/hibp-breaches --email test@example.com
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `email` | yes |  |

## Keys

`HIBP_API_KEY`, set with `ot keys set HIBP_API_KEY`. Searching by email address needs a paid HIBP subscription: https://haveibeenpwned.com/API/Key. Without the key the tool exits with code 3.

## Notes

Unverified breaches are included, with medium confidence; HIBP leaves sensitive breaches out of these searches. An address in no breach gives no entities and a note on stderr. The results say something about a person, so `ot` and agents treat a run as collecting personal data and ask before running it.

## Next steps

See which services the address is registered with using [osintverse-community/holehe](https://otinstaller.com/osintverse-community/holehe).

## Development

```
pip install pyhibp==4.2.0
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
