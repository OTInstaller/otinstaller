# email-header-parser

Reads the headers of a suspicious email and pulls out who it claims to be from, the reply and bounce addresses, the servers it passed through with their public IPs and times, and the SPF, DKIM and DMARC verdicts. Runs offline.

```
ot run osintverse-community/email-header-parser --headers "$(cat headers.txt)"
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `headers` | yes | The raw headers, as copied from "Show original"; \n escapes are accepted |

## Notes

Copy the headers from your mail client (Gmail: ⋮ → Show original; Outlook: File → Properties). Received hops are listed oldest first; private and reserved IPs are left out. Header values can be forged by the sender, except the hops added by servers you trust (normally the last one or two).

## Next steps

Check the relay IPs with [osintverse-community/ipwhois](https://otinstaller.com/osintverse-community/ipwhois) and the sender's domain with [osintverse-community/checkdmarc](https://otinstaller.com/osintverse-community/checkdmarc).

## Development

```
pip install # no dependencies
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
