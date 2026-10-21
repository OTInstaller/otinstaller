# Product Hunt (draft, not posted or scheduled)

Thursday 22 October 2026, live at 00:01 Pacific (07:01 UTC, 12:31 IST) so the full day counts. The maker's first comment goes up at once.
Don't ask for upvotes; ask people to try it and comment. Have the demo video ([../demo-video.md](../demo-video.md))
and the gallery images ready before scheduling.

**Name:** OTInstaller

**Tagline** (60 characters max, this is 53):

> Install and run any OSINT tool with one command, free

**Description** (260 characters max, this is 259 with the backticks; drop them if PH shows them literally):

> A free registry of open-source intelligence tools and investigation guides, and `ot`, a CLI that installs and runs
> them the same way on Windows, macOS and Linux. Releases are signed, scanned and reviewed; tools run on your machine
> and your results stay there.

**Topics:** Developer Tools, Security, Open Source, Command Line Tools (choose up to the limit PH allows).

**Links:** https://otinstaller.com · https://otinstaller.com/docs/getting-started

**Pricing:** Free. Open source (Apache-2.0): https://github.com/OTInstaller/otinstaller

## Gallery (1270×760 PNG or the video first)

1. The demo video, or a still: terminal with the three commands and "12 accounts found" (see the demo shot list).
2. Home page: the "Start from what you have: I have a… Email, Username, Phone…" picker.
3. A tool page (holehe): health "Healthy, checked last night", signed, scans passed, ethics answers.
4. `ot auto` summary table in a terminal.
5. A guide page (Email investigation playbook) with its "install every tool" command.
6. The publish flow: import wizard opening a pull request.

## Maker's first comment

> Hi Product Hunt! I'm {name} from OSINTverse.
>
> If you've ever tried to run five OSINT tools in an afternoon, you know the drill: five READMEs, three Python
> versions, two that broke last month, and output you have to copy into a spreadsheet by hand.
>
> OTInstaller fixes the boring part. One command installs any tool on the registry (`ot install …`), one runs it
> (`ot run …`), and every tool returns the same JSON, so you can run everything that takes an email in one go and
> pull out the accounts it found.
>
> Things we cared about:
> 🔏 Releases are signed by the author's own CI and checked before they run
> 🧪 Every release is scanned, and a person reviews each new publisher
> 🩺 A nightly health check tells you whether a tool still works
> 🏠 Tools run on your machine. We never see your targets or results
> 📚 Guides walk through real investigations and install the tools they use
> 🤖 Works with AI agents through `ot mcp`, which asks you before any run that touches a target
>
> Tool authors: publishing is a pull request away. Sign in with GitHub or GitLab, pick your repo, and the import
> wizard writes the manifest and release workflow for you.
>
> It's free, and we'd love to hear what tool you'd want next.

## During the day

- Reply to every comment within an hour (community role in [../on-call-rota.md](../on-call-rota.md)).
- Share the PH link only where the launch posts go anyway; no upvote requests.
