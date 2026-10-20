# phone-parse

Checks a phone number against Google's libphonenumber data and reports whether it is valid, its E.164 and national formats, the country and area, the carrier the range was assigned to, the line type (mobile, fixed line, VoIP, toll free…) and its time zones. Runs offline.

```
ot run osintverse-community/phone-parse --phone "+44 20 7946 0958"
```

## Inputs

| Input | Required | |
| --- | --- | --- |
| `phone` | yes |  |
| `region` | no | Two-letter country for numbers without a + prefix, such as US |

## Notes

The carrier is the one the number block was originally given to; numbers can be ported to another carrier since. The location is the area the range covers, not where the phone is.

## Next steps

Check which services the number is registered with using [osintverse-community/ignorant](https://otinstaller.com/osintverse-community/ignorant).

## Development

```
pip install phonenumbers==9.0.41
python -m unittest
ot validate
```

Releases are built, signed and published by the `otinstaller release` workflow (Actions tab, with the version to release).

## License

MIT
