# Build candidate usernames

Start from what you have.

## From a known handle

Write down the exact handle, then the variants people commonly use for the same identity:

- separators added or removed: `jane.doe`, `jane_doe`, `janedoe`, `jane-doe`
- numbers people append: birth years, `1`, `01`, `x`
- the platform prefix or suffix some people add: `realjanedoe`, `janedoe_dev`, `janedoeofficial`

## From a name

Let `username-permutations` generate the common patterns. It runs offline and only builds a list:

```
ot run osintverse-community/username-permutations --name "Jane Doe" --extra 1990 --format table
```

You get handles such as `janedoe`, `jane.doe`, `jdoe`, `doe_jane` and `janedoe1990`, each with the pattern that made
it. Accents are folded to ASCII, so "Zoë" also gives `zoe`.

> [!TIP]
> Keep the list short. Checking 200 candidates on 3,000 sites is slow and noisy; start with the 10 to 20 most
> likely patterns, then widen if nothing turns up.

Save the list for the next step:

```
ot run osintverse-community/username-permutations --name "Jane Doe" --format json -o candidates.json
```

Next: [find accounts](03-find-accounts.md).
