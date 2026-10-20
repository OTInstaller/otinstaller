# username-permutations

Turns a person's name into the usernames they are likely to use (`ada.lovelace`, `alovelace`, `lovelace_ada`,
…), so you can check them with a username search tool. Runs offline and contacts nothing.

```
ot run osintverse-community/username-permutations --name "Ada Lovelace" --extra 1815
```

Each result is a `username` entity with the pattern that produced it. Confidence is always `low`: these are
guesses to check, not findings.

## Inputs

| Input | Required | |
| --- | --- | --- |
| `name` | yes | Full name; accents are folded to ASCII |
| `extra` | no | A year, number or nickname appended to the most common patterns |

## Next steps

Pipe the candidates into [osintverse-community/sherlock](https://otinstaller.com/osintverse-community/sherlock) or
[osintverse-community/maigret](https://otinstaller.com/osintverse-community/maigret).

## License

MIT
