---
layout: ../../layouts/Policy.astro
title: Privacy
description: What the OTInstaller Registry stores about you, and what it doesn't.
updated: 2026-10-20
---

## Using tools

Tools run on your own machine; their inputs and results never reach the registry. When you install a tool, `ot` sends an anonymous count of the package and version, once per version per machine. We store a daily total per version, never an IP address, user or token. Turn it off with `OT_NO_TELEMETRY=1`.

## Accounts

Signing in with GitHub or GitLab gives us your login, name, avatar and email address. Your email is used for publishing results and review decisions and is never shown publicly. Access tokens for your GitHub or GitLab account are stored encrypted and used only for what you ask the registry to do (listing your repositories, opening pull and merge requests). Unlinking an account removes its tokens and webhooks.

## Reports

Reports can be anonymous. To limit abuse we count reports per address for an hour using a salted hash of the address, never the address itself, and delete the counts after a day.

## The website

The website uses one cookie, for sign-in. It has no analytics cookies.

## Contact

Questions or requests about your data: [privacy@otinstaller.com](mailto:privacy@otinstaller.com).
