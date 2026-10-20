# Verify and pivot

A hit means "a page exists at this URL". It does not mean the account belongs to your subject.

## Verify

Open each profile and look for at least two independent links to what you already know:

| Signal | Strength |
| --- | --- |
| The profile links to another account you already attributed | Strong |
| Same profile photo (check with [osintverse-community/image-hash](https://otinstaller.com/osintverse-community/image-hash)) | Strong |
| Same display name, location and stated job | Medium |
| Writing style, interests, posting times | Weak on its own |
| Only the handle matches | Not enough |

Mark each account **confirmed**, **likely** or **unrelated**, and write down why.

## Pivot

Confirmed accounts usually expose new identifiers. Each one has its own playbook:

- a different handle in a bio or a link: back to [step 2](02-candidates.md)
- an email address: [email investigation](https://otinstaller.com/guides/osintverse-community/email-investigation)
- a personal website or domain: [domain investigation](https://otinstaller.com/guides/osintverse-community/domain-investigation)
- photos: [image geolocation](https://otinstaller.com/guides/osintverse-community/image-geolocation)
- profile media and posts: [social media profiles](https://otinstaller.com/guides/osintverse-community/social-media-profiles)

## Report

Summarise what you found against the question you set in [scope](01-scope-and-legal.md): the confirmed accounts,
how you confirmed each, and what you left out. Keep the raw tool output (`-o results.json`) with the case notes.
