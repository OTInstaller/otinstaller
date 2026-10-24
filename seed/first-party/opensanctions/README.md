# opensanctions

Screens a person's or a company's name against OpenSanctions, which gathers sanctions lists, politically exposed persons (PEPs) and their relatives and close associates, criminal and other watch lists from hundreds of official sources into one database. It uses OpenSanctions' matching API, which scores how well each listed person, company or other entity fits the name and, when given, a birth date and a country. Each match comes with its score, what it is listed for (topics such as `sanction`, `role.pep` or `crime`), the sources and sanctions programmes that list it, its countries, aliases, positions and birth date or registration numbers, and a link to its OpenSanctions page. Only OpenSanctions' data is read, so nobody is contacted.

```
ot run osintverse-community/opensanctions --name "Vladimir Putin"
ot run osintverse-community/opensanctions --company "Rosneft" --country ru
```

## Inputs

Give exactly one of `name` or `company`.

| Input | Required | |
| --- | --- | --- |
| `name` | one of these | A person's full name |
| `company` | one of these | A company or organisation name |
| `birth_date` | no | The person's date or year of birth, such as `1952` or `1952-10-07`, to tell namesakes apart |
| `country` | no | A country linked to the person or company (nationality, residence or jurisdiction), as a name or code |
| `limit` | no | Most matches to return, 5 by default, up to 25 |

## Keys

`OPENSANCTIONS_API_KEY`, set with `ot keys set OPENSANCTIONS_API_KEY`: https://www.opensanctions.org/account/. The API is paid for businesses, by the query (each run uses one credit), after trial credits for a new account; OpenSanctions gives free keys to journalists, NGOs and academic researchers who apply. Without the key the tool exits with code 3.

## Notes

A score of 0.7 or more counts as a match. A name alone matches namesakes, so add `birth_date` and `country` when you know them, and read each match before acting on it; being a politically exposed person is not wrongdoing. The results describe people, so `ot` and agents treat a run as collecting personal data and ask before running it. OpenSanctions' data is licensed CC BY-NC 4.0: cite OpenSanctions when you use it.

## Next steps

Open a match's `link` for its full record and sources, or look a company up in the official registers with [osintverse-community/companies-house](https://otinstaller.com/osintverse-community/companies-house) and [osintverse-community/gleif](https://otinstaller.com/osintverse-community/gleif).

## Development

```
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
