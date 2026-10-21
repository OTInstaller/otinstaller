# Closed beta invitation (draft)

Not sent. Two versions: one for tool authors, one for investigators. Replace the `{…}` fields. Send from a person,
not from registry@, so replies reach someone. Send only once everything under "Blocking the beta" in
[../launch-checklist.md](../launch-checklist.md) is done (in particular, `ot` must be installable).

---

## For tool authors

**Subject:** Early access: publish {tool name} to the OTInstaller Registry

Hi {first name},

I'm {sender} from OSINTverse. We're building OTInstaller Registry (otinstaller.com), a free, public registry of
OSINT tools and investigation guides, with `ot`, a small CLI that installs and runs them on the investigator's
own machine. It indexes your repository rather than hosting your code: your tool stays on GitHub or GitLab, and
the registry checks each tagged release (signature, vulnerability and malware scans, a smoke test) before it
lists it.

Before we open it to everyone on {launch date}, we're inviting about 20 people for a two-week closed beta, and
we'd like {tool name} to be one of the first tools published by its own author.

What it would take from you, roughly 30 minutes:

1. Sign in at https://otinstaller.com with GitHub or GitLab.
2. Open https://otinstaller.com/import and pick {repository}. The registry drafts `otinstaller.yaml` and a release
   workflow and opens a pull or merge request for you to review.
3. Merge it and run the release workflow (GitHub) or pipeline (GitLab). We review a new publisher's first release
   by hand, usually within a day.

The step-by-step guide is here: {link to the author onboarding page}.

What you get: `ot install {namespace}/{tool}` for every user, a package page with health checks and install
counts, and a place in the launch announcement. You keep full control of your namespace; nothing is published
without a tag you push.

What we'd ask in return: tell us what was confusing or broken. Use the feedback form on the site, `ot feedback`
in the terminal, or reply to this email. For bugs that block you, please open an issue: https://github.com/OTInstaller/feedback/issues.

If you'd rather not, no problem, and thank you for {tool name} either way.

{sender}
{title}, OSINTverse

---

## For investigators

**Subject:** Try OTInstaller before launch: OSINT tools in one command

Hi {first name},

I'm {sender} from OSINTverse. We're about to launch OTInstaller Registry (otinstaller.com): a free registry of
OSINT tools and investigation guides, and `ot`, a CLI that installs and runs them on your machine, with each tool
in its own container, signatures checked, and results saved with their metadata.

```
ot run osintverse-community/holehe e:someone@example.com
ot run --all u:johndoe
ot playbook username-investigation u:johndoe
```

We're inviting about 20 investigators to a two-week closed beta before the public launch on {launch date}. If
you can spend an hour or two on real (or practice) cases in that time, it would help us a lot.

1. Install ot: {install command for Windows / macOS / Linux, from the getting-started page}
2. Run `ot doctor`. It tells you what's missing (usually Docker Desktop).
3. Try a few tools and a guide: https://otinstaller.com/guides

Tell us what worked and what didn't: `ot feedback "…"` from the terminal, the form at https://otinstaller.com/feedback,
or a reply to this email. Blocking bugs go here: https://github.com/OTInstaller/feedback/issues. At the end we'll send a five-minute survey.

Thanks,
{sender}
{title}, OSINTverse

---

## Follow-up (day 3, to people who haven't started)

**Subject:** Re: OTInstaller beta

Hi {first name}, a quick nudge in case this got buried. Getting started takes about ten minutes:
{getting-started link}. If something stopped you, a one-line reply telling us what it was is just as useful.

{sender}
