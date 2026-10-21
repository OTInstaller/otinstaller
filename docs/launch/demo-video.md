# Demo video: "From an email to 12 accounts in 3 commands" (script and shot list)

About 60 seconds, recorded against production (otinstaller.com and the real registry). Used on Product Hunt, X,
LinkedIn and the blog post; a 30-second cut for X if needed.

## The three commands

```
ot guide tools osintverse-community/email-investigation --yes
ot auto {demo email} --case demo
ot extract --case demo
```

1. Installs every tool the Email investigation playbook uses: holehe, socialscan, mailcat, email-header-parser,
   checkdmarc and dns-records (signatures checked as they install).
2. Guesses the target is an email address and runs every installed tool that takes one; holehe checks 120+ sites
   for an account registered with it, without alerting the owner, and `ot auto` prints a summary table.
3. Pulls the accounts (and any emails, domains, URLs) out of the saved results.

**Production check (21 Oct):** the commands and the guide exist on production. A dry run with holehe's own test
input could not finish: Docker Desktop was not running on the machine. {Result of the dry run, how long each step
takes, and the exact output, once run.}

## The demo email: make "12" true and nobody's privacy at stake

The number on screen must be real, and the address must not be a real person's (or a teammate's personal) address.

- Create a dedicated demo address, e.g. a new mailbox at a provider holehe checks, used only for this video.
- Sign it up, by hand, to about 12 services that holehe covers (pick ordinary ones: a few social networks, a music
  service, a developer site, a shopping site). Use made-up profile details. Keep a list.
- Run step 2 off camera first and check holehe reports them. If the count differs, change the title ("…to 11
  accounts") rather than edit the output.
- Delete those accounts after the launch, or keep the list for re-recording.
- Never record against a real third party's address, even a public figure's.

## Recording setup

- Fresh `ot` state so nothing is cached: `OT_HOME=$(mktemp -d)`; telemetry off so the demo doesn't count as installs
  (`OT_NO_TELEMETRY=1`); a clean results folder.
- Docker Desktop (or Podman) running; images not pre-pulled if you want honest timing, or pre-pulled and the install
  shown at speed with a "sped up" label.
- Terminal: dark theme, 22–24 pt font, 100×28, a short prompt (`$ `), no hostname or username, no other tabs.
- Record at 1920×1080, 60 fps (OBS), or with `asciinema rec` for a sharp text version (convert with `agg` for GIFs).
- Browser: a clean profile at 1920×1080, signed out, zoom 125%, no bookmarks bar; the beta strip gone (site built
  with `PUBLIC_BETA=0`).

## Shot list

| # | Time | Shot | On screen | Voice-over / caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:04 | Title card | "From an email to 12 accounts in 3 commands" · OTInstaller logo | — |
| 2 | 0:04–0:10 | Browser: otinstaller.com home, scroll to "Start from what you have", click **Email** | The email tools and the Email investigation playbook | "OTInstaller is a free registry of OSINT tools and guides." |
| 3 | 0:10–0:14 | Browser: the Email investigation playbook page, highlight the install command | `ot guide tools osintverse-community/email-investigation` | "Start from a guide." |
| 4 | 0:14–0:24 | Terminal: command 1 | Six tools installing, "signature verified" lines (speed up the pulls, label "sped up") | "One command installs every tool it uses. Each one's signature is checked first." |
| 5 | 0:24–0:38 | Terminal: command 2 | `ot auto` detecting "email", holehe running, the summary table | "ot auto sees an email address and runs every tool that takes one." |
| 6 | 0:38–0:48 | Terminal: command 3 | The list of accounts, the count "12" highlighted (zoom or box) | "And ot extract pulls out what they found: 12 accounts." |
| 7 | 0:48–0:54 | Browser: holehe's tool page | Signed · Scan passed · Healthy · "Community-packaged" and the upstream credit | "Every tool is signed, scanned, and tested every night. It all runs on your machine." |
| 8 | 0:54–1:00 | End card | `curl -fsSL https://get.otinstaller.com/ot \| sh` · otinstaller.com · "Free" | "Get started at otinstaller.com." |

**30-second cut:** shots 1, 4 (3 s), 5, 6, 8.

## Captions and accessibility

- Burn in captions for the voice-over (most social video plays muted), and upload an `.srt` where the platform takes
  one.
- Keep each command on screen for at least 2 seconds before its output.
- Alt text for the Product Hunt gallery still: "Terminal running three ot commands that find 12 accounts registered
  with a demo email address."

## Before publishing the video

- [ ] The count on screen matches the title.
- [ ] No personal data on screen: the demo address only, no real names, no other tabs, no notifications.
- [ ] Commands are exactly as the current `ot` release prints them (re-record if `ot` changes before launch).
- [ ] The user approves the final cut before it goes anywhere.
