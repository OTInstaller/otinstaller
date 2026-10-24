# sec-edgar

Finds a company in the SEC's EDGAR filings by name or ticker. The best match comes back in full: its CIK, tickers and exchanges, industry (SIC code and description), state of incorporation, fiscal year end, business and mailing addresses, and its latest filings with form, date, accession number and a link to each. Other close matches are listed with their CIK, ticker and match score. Uses the edgartools library for the SEC's free EDGAR data. Only the SEC's public data is read, so the company is not contacted.

```
ot run osintverse-community/sec-edgar --company Apple
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `company` | yes | Company name or ticker |
| `limit` | no | How many matching companies to list: 5 by default, up to 25 |
| `filings` | no | How many of the best match's latest filings to list: 10 by default, up to 100 |

## Keys

`EDGAR_IDENTITY`, set with `ot keys set EDGAR_IDENTITY`. It isn't a secret: the SEC asks every program that reads EDGAR to say who is behind it, so set your name and email address, such as `Jane Doe jane@example.com` (https://www.sec.gov/os/accessing-edgar-data). Without it the tool exits with code 3.

## Notes

Names are matched against the SEC's list of companies with tickers, so a company that files with the SEC but has no listed shares may not be found by name. The SEC allows at most ten requests a second per client, which one run stays well under.

## Next steps

Look the company up in [osintverse-community/gleif](https://otinstaller.com/osintverse-community/gleif) for its Legal Entity Identifier.

## Development

```
pip install edgartools==5.62.1
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
