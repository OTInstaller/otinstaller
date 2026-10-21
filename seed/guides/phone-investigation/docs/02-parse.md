# Parse the number

Normalise the number first. People write the same number many ways, and every later step works better with the
international E.164 form (`+12025550123`).

```
ot run osintverse-community/phone-parse --phone "+1 202-555-0123"
ot run osintverse-community/phone-parse --phone "(202) 555-0123" --region US
```

Use `--region` for numbers written without a country code. The tool runs offline on Google's libphonenumber data and
returns:

| Field | Meaning |
| --- | --- |
| `valid` / `possible` | Whether the number fits the country's numbering plan |
| `e164`, `international`, `national` | The standard ways to write it; search for all of them |
| `region`, `location` | Country and, for fixed lines, the area the range covers |
| `carrier` | The carrier the range was assigned to (see the porting note in [scope](01-scope-and-legal.md)) |
| `line_type` | `mobile`, `fixed_line`, `voip`, `toll_free`, `premium_rate`… |
| `time_zones` | Useful when matching activity times |

> [!TIP]
> `voip` numbers are cheap to get and common for throwaway accounts. A `fixed_line` number with an area points to a
> place, which mobile numbers do not.

`phoneinfoga` gives a second view with its own number scan:

```
ot run osintverse-community/phoneinfoga --phone "+12025550123"
```

Next: [accounts and mentions](03-accounts-and-mentions.md).
