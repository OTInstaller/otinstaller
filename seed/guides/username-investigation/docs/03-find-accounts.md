# Find accounts

Each tool checks a different site list in a different way, so use more than one and compare.

## 1. Sherlock: a fast first pass

```
ot run osintverse-community/sherlock --username github
```

Sherlock checks 400+ sites and prints the profile URL for each one where the name exists. Add `--site GitHub` to
check a single site. It is fast but relies on simple signals (status codes, error text), so expect some false
positives on sites that answer every URL.

## 2. Maigret: depth on the hits

```
ot run osintverse-community/maigret --username github --top-sites 500
```

Maigret covers far more sites, and on many of them it also reads the profile: display name, bio, links, other
usernames and IDs it finds on the page, which it then searches recursively. Use it on the candidates that Sherlock
confirmed, or on your single best candidate.

## 3. socialscan and naminter: second opinions

```
ot run osintverse-community/socialscan --query github
ot run osintverse-community/naminter --username github --category social
```

socialscan uses each big platform's own sign-up checks, which are accurate for the handful of sites it covers.
naminter uses the community-maintained WhatsMyName list, which is curated to avoid false positives.

## 4. Email addresses with the same handle

People often use their handle as the local part of an email address:

```
ot run osintverse-community/mailcat --username janedoe
```

Treat these as candidates too: check them with the [email playbook](https://otinstaller.com/guides/osintverse/email-investigation).

> [!NOTE]
> Record for each hit: the URL, the tool that found it, and the date. Results change as sites change.

Next: [verify and pivot](04-verify-and-pivot.md).
