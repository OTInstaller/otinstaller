---
layout: ../../layouts/Policy.astro
title: Privacy
description: What the OTInstaller Registry stores about you, and what it doesn't.
updated: 2026-10-23
---

## Using tools

Tools run on your own machine; their inputs and results never reach the registry. When you install a tool, `ot` sends an anonymous count of the package and version, once per version per machine. We store a daily total per version, never an IP address, user or token. Turn it off with `OT_NO_TELEMETRY=1`.

## Accounts

Signing in with GitHub or GitLab gives us your login, name, avatar and email address. Your email is used for publishing results and review decisions and is never shown publicly. Access tokens for your GitHub or GitLab account are stored encrypted and used only for what you ask the registry to do (listing your repositories, opening pull and merge requests). Unlinking an account removes its tokens and webhooks.

## Issues, comments and confirmations

What you post in the community is public: your handle, your avatar (unless you hide your profile), the text, and
the version, platform, engine and exit code you give. "Works for me" and "broken for me" answers are counted by
version and platform; the count is public, who answered is not shown on the package page.

- You can edit a post for 24 hours and withdraw it at any time; a withdrawn post's text is deleted.
- A post a moderator redacts is overwritten for good. The database keeps a backup copy for 30 days.
- Flags you send, and moderators' decisions, are recorded with your account and never shown publicly.

## Reports

Reports can be anonymous. To limit abuse we count reports per address for an hour using a salted hash of the address, never the address itself, and delete the counts after a day.

## The website

The website uses one cookie, for sign-in. It has no analytics cookies.

## Contact

Questions or requests about your data: [privacy@otinstaller.com](mailto:privacy@otinstaller.com).
