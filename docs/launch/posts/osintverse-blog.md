# OSINTverse blog post (draft, not published)

For the OSINTverse Hub (hub.osintverse.com) or blog. About 800 words. Embed the demo video under the first section.
For Thursday 22 October 2026. The newsletter to OSINTverse users (in the plan) can reuse the first three
paragraphs and link here.

**Title:** Introducing OTInstaller: every OSINT tool, one command

**Subtitle / meta description:** A free registry of open-source intelligence tools and guides, and a CLI that
installs, runs and checks them the same way on Windows, macOS and Linux.

---

Every investigator has the same folder. It holds a username checker that needs Python 3.9, an email tool that
stopped working when a site changed its sign-up page, a subdomain finder with its own output format, and a text file
of install commands that worked once. Before the real work starts, there is an hour of setup.

Today we're launching **OTInstaller Registry** (https://otinstaller.com): a free, public registry of OSINT tools and
investigation guides, and **`ot`**, a small command-line program that installs and runs any of them the same way.

{demo video: "From an email to 12 accounts in 3 commands"}

## One way to install and run everything

```
ot guide tools osintverse-community/email-investigation
ot auto you@example.com --case demo
ot extract --case demo
```

The first command installs every tool the email investigation guide uses. The second guesses that the target is an
email address and runs every installed tool that takes one. The third pulls the accounts, domains and other entities
out of the results. The same three verbs work for usernames, domains, phone numbers, IP addresses, images and
cryptocurrency addresses.

Behind those commands, every tool on the registry has a manifest: what it takes as input (an email, a username, a
domain…), what it finds, how to run it, and whether it needs an API key. `ot` reads it, so you never need to know
whether a tool is a Docker image or a Python package, or what its flags are. Every run returns the same JSON result
envelope and is saved with a checksum and a metadata file, which makes notes, reports and chaining tools much easier.

## Built to run other people's code safely

Running a stranger's script is the uncomfortable part of OSINT, so the registry is strict about what it lists:

- **Signed by the author's own build.** Each release is built and signed by the author's GitHub or GitLab CI. `ot`
  checks the signature against the identity recorded when it was published, and refuses a mismatch.
- **Pinned.** Images are referenced by digest and Python packages by hash, so a version can never change later.
- **Scanned and reviewed.** Every release is scanned for vulnerabilities, secrets and malicious packages and
  smoke-tested without network access. A person reviews every new publisher before their first tool goes live.
- **Locked down when it runs.** Tools run in a read-only container with no capabilities, no host folders and no
  shell between your input and the tool.
- **Checked every night.** OSINT tools break when websites change. Each tool's test runs nightly, and its page says
  whether it worked last night.

## Your investigations stay yours

Tools run on your own machine. The registry never sees who or what you look up, or what the tools find. `ot` sends
only an anonymous install count, which you can turn off. Every tool declares whether it contacts the target, logs
in to accounts or collects personal data, and the [acceptable use policy](https://otinstaller.com/policy/acceptable-use)
rules out stalkerware, credential attacks and leaked data. Anyone can report a tool, and every removal is listed on
the [transparency page](https://otinstaller.com/policy/transparency).

## Guides that set up their own tools

The registry also hosts guides: investigation playbooks for an email address, a username, a domain, an IP address,
a phone number, an image, social media profiles and a cryptocurrency address, plus guides for publishing your own
tool and guide (10 in all). Each guide links only to
tools on the registry, and `ot guide tools` installs all of them at once. Read them on the site or in the terminal
with `ot guide read`.

## For tool authors

Your code stays where it is. Sign in with GitHub or GitLab, open the [import wizard](https://otinstaller.com/import),
pick a repository, and the registry drafts the manifest and a release workflow and opens a pull or merge request.
Merge it, run the workflow, and every tagged release after that is checked and published automatically. You get a
package page, install counts, health checks, and backups: if your repository is ever taken down by mistake, the
registry's mirror keeps installs working and you can restore your code from a bundle.

Many well-known tools are already on the registry as community-packaged wrappers, credited to their authors. If you
maintain one, you can claim it and keep its history and installs.

## What's next

OTInstaller is free, and its code is open source under Apache-2.0
([github.com/OTInstaller/otinstaller](https://github.com/OTInstaller/otinstaller)). Next we're working on more tools (tell us which ones), a weekly "new tools" digest, and a
public roadmap. A hosted "run it in the cloud" option may follow later; the free registry stays free.

Get started in a minute:

```
curl -fsSL https://get.otinstaller.com/ot | sh          # macOS and Linux
irm https://get.otinstaller.com/ot.ps1 | iex            # Windows PowerShell
ot doctor
```

Then browse the registry at https://otinstaller.com, and tell us what you think with `ot feedback`.
