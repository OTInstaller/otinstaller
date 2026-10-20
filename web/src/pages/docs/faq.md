---
layout: ../../layouts/Docs.astro
title: FAQ
description: Common questions about the OTInstaller Registry.
---

## Is it free?

Yes. Browsing, installing, running and publishing are free.

## Do my searches or results go to the registry?

No. Tools run on your machine and their results stay there. `ot` sends one anonymous install count per tool version (no IP address or user is stored); set `OT_NO_TELEMETRY=1` to turn it off.

## Do I need Docker?

For Docker tools, yes (Docker Desktop, OrbStack, Colima or Podman). Python tools also run in a container when Docker is available; without it, `ot` asks before running them directly on your machine.

## Can I publish a tool someone else wrote?

Only as a community wrapper in the `osintverse-community` namespace, when the license allows it. The original authors can claim it at any time and keep its history.

## What does "Manifest held by registry" mean?

The package's `otinstaller.yaml` is kept by the registry instead of in the repository. It works the same, but the package is never shown as signed and ranks slightly lower until the manifest moves into the repository.

## A tool is "Possibly broken". What now?

Its nightly health check failed three times in a row, usually because a site it queries changed. It still installs; check its repository for updates.

## Why was my release rejected?

The commit status on your tag and the [dashboard](/dashboard) name the error code. See [Error codes](/docs/errors).
