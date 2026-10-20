# Profiles

## Read the profile

Open the profile in a browser that isn't signed in to the platform, so you see what the public sees. Note the display
name, bio, links out, follower counts, account type (business, verified, private) and the most recent posts. Many
platforms limit what they show signed-out visitors and block automated requests from servers, so a careful manual
read is often the most reliable first step.

For media-heavy profiles, `gallery-dl` lists the posts and their metadata without downloading anything; see
[media](03-media.md).

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
