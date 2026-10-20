# Profiles

## Instagram

```
ot run osintverse-community/instaloader-profile --username instagram
```

For a public profile you get the display name, biography, external link, follower and following counts, account type
(business, verified, private) and, unless it is private, the 12 most recent posts with dates, captions, likes and
tagged locations. Instagram limits anonymous requests, so space out lookups.

## The same person elsewhere

Profiles link to each other through bios, link-in-bio pages and repeated handles. Check the handle on other networks:

```
ot run osintverse-community/sherlock --username instagram
```

and follow the [username playbook](https://otinstaller.com/guides/osintverse-community/username-investigation) to verify matches.

## What to record

For each profile: the URL, the numeric user ID when available (it survives a rename, the handle doesn't), the display
name and bio as they were on the date you looked, and the links out.

Next: [media](03-media.md).
