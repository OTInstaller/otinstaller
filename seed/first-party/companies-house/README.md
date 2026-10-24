# companies-house

Searches the UK's Companies House register by company name, or reads one company by its number. A search lists matching companies with their number, status and registered office. A company number gives its full profile (name, status, type, incorporation and dissolution dates, SIC codes, registered office), its officers (directors and secretaries, with role, appointment and resignation dates, occupation, nationality and month and year of birth) and the people or companies with significant control over it. Uses Registrum's companies-house client for the free Companies House public data API. Only the public register is read, so the company is not contacted.

```
ot run osintverse-community/companies-house --number 00445790
```

## Inputs

Give `company` or `number`.

| Input | Required | |
| --- | --- | --- |
| `company` | one of these | Company name to search for |
| `number` | one of these | Company number; leading zeros can be left out |
| `limit` | no | Most companies a name search returns: 20 by default, up to 100 |

## Keys

`COMPANIES_HOUSE_API_KEY`, set with `ot keys set COMPANIES_HOUSE_API_KEY`: a free REST API key for the live environment from https://developer.company-information.service.gov.uk/. Without the key the tool exits with code 3.

## Notes

Companies House allows 600 requests every five minutes per key, and a company number takes three. The officers and owners are people as the public register lists them, so `ot` and agents treat a run as collecting personal data and ask before running it.

## Next steps

Search for the same company in other registers with [osintverse-community/gleif](https://otinstaller.com/osintverse-community/gleif), or find its staff's addresses with [osintverse-community/hunter-domain-search](https://otinstaller.com/osintverse-community/hunter-domain-search).

## Development

```
pip install companies-house==0.2.1
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
