---
layout: ../../layouts/Docs.astro
title: Keeping tools up to date
description: "How the registry follows upstream projects, how ot tells you about newer versions, and how to update, hold a version, go back and update on a schedule."
---

OSINT tools change often: the sites they query change, and their authors fix them. Keeping up has two halves. The
registry follows each tool's upstream project and publishes new versions, and `ot` tells you when the copies on your
machine are behind and updates them through the same checks as a first install.

## How the registry follows upstream

- **Publishers' own tools** are released from their repositories: a tag or a release upload becomes a new version
  within minutes, after it is validated and security-scanned.
- **Community wrappers** (tools packaged under `osintverse-community` from someone else's project) pin one upstream
  release. Every night the registry compares that pin with upstream's latest release, and the tool's page says when
  upstream has moved on. When it is switched on, an outdated issue is filed and a pull request bumps the pin, which a
  maintainer releases.
- **Every new version** is built, signed, scanned and smoke-tested before it is published, and the nightly health check
  runs each tool's test input again. For a week after a release, its page and `ot outdated` say how many people found
  it working or broken.

## Finding out

From ot 0.16, `ot` tells you itself. At most once a day, at a terminal, after a command's output, it notes how many
installed packages have newer versions, and whether a newer `ot` is out:

```
note: 2 installed packages have newer versions; `ot outdated` lists them, `ot update --all` installs them
```

The note never appears in CI, under `ot mcp`, with JSON output or without a terminal. `OT_NO_UPDATE_CHECK=1` turns it
off.

To look yourself:

| Command | What it says |
| --- | --- |
| `ot outdated` | Every installed package with its latest version, and flags: deprecated, possibly broken, yanked, source unavailable, moved, held. Changes nothing |
| `ot changelog <tool>` | The release notes of the versions newer than yours (`--all` for every version) |
| `ot info <tool>` | The latest version's release notes, under "What's new" |

To follow a tool without `ot`, subscribe to its feed, `/<namespace>/<tool>/feed.atom`
([feeds](/docs/automation#feeds-staying-up-to-date)).

## Updating

```
ot update --all
ot update osintverse-community/sherlock
```

An update goes through the same digest pinning, signature check and trust warnings as `ot install`. A package that
moved is installed under its new name. `ot update` exits 1 when an update failed.

## Holding a version, and going back

Installing an exact version holds it there:

```
ot install osintverse-community/sherlock@0.15.0
```

`ot update --all` leaves a held package alone, and `ot outdated` and `ot list` mark it `held`. Naming it, with
`ot update <tool>` or `ot install <tool>`, moves it to the latest version and releases the hold. Agents never hold or
release a version, and never move one you held.

To go back after an update, find the version you had with `ot changelog <tool> --all` and install it: that also holds
it until you move it on. Only packages installed at an exact version from ot 0.16 on are held; install an older one
again to hold it.

## Updating on a schedule

`ot update --all --json` needs no terminal and prints one row per package. It exits 1 only when an update failed, so a
scheduled job can alert on that. Docker or Podman must be running when it starts.

With cron on Linux or macOS, give the full path to `ot`:

```
0 7 * * 1 /usr/local/bin/ot update --all --json >> ~/ot-update.log 2>&1
```

On Windows, Task Scheduler runs it while you are signed in:

```
$a = New-ScheduledTaskAction -Execute "ot" -Argument "update --all --json"
Register-ScheduledTask -TaskName "ot update" -Action $a -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 7am)
```

In CI, run it on a runner that keeps `ot`'s data folder between jobs; a fresh runner has nothing installed to update.
Results record the version that produced them, so a case can always say which version found what.

## Agents

Through [`ot mcp`](/docs/agents), `list_installed` gives each tool's latest version and whether an update is available,
and `install_tool` on an installed tool updates it after asking: "Update x from 1.2.0 to 1.3.0?". Approving an install
for the session covers that version only.

## Privacy

The daily check downloads one list of every package's latest version, the same for everyone
([`GET /v1/latest`](/docs/api)), so it tells the registry nothing about what you have installed. `ot outdated`, by
contrast, asks about each installed package by name, anonymously, without your token.
