# Preserve

Posts get deleted, profiles go private, handles change. Preserve what matters as you find it.

## Archived copies

Check whether the Wayback Machine has the profile, and since when:

```
ot run osintverse-community/waybackpy --url "https://www.instagram.com/instagram/" --mode oldest
ot run osintverse-community/waybackpy --url "https://www.instagram.com/instagram/" --mode newest
```

Many profile pages are archived, sometimes years before a rename or a deletion. Archive important pages yourself with
the Wayback Machine's *Save Page Now* or archive.today before you cite them.

## Your own record

- Save each tool's output with `-o` (JSON keeps everything): `ot run … --format json -o profile-2026-10-20.json`.
- Take full-page screenshots with the date and URL visible for anything you will show to others.
- Keep a short log: what you collected, when, with which tool and version (`ot list` shows installed versions).

## Wrap-up

Report the accounts, what each showed on which date, and the evidence for attributing them. Leave out third parties
and anything outside your [scope](01-scope-and-legal.md).
