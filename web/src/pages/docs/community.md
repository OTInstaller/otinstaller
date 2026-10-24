---
layout: ../../layouts/Docs.astro
title: Community
description: Reporting a problem, issues, "works for me", triage and moderation, and the API behind them.
---

The people who run a tool are the first to know when it breaks, falls behind its upstream, or says something
untrue. The registry gives them a place to say so, in public, where maintainers and other users can see and act on
it. Reading everything needs no account, and neither does counting a tool as broken or out of date; writing needs a
GitHub, GitLab or OSINTverse sign-in.

## Report a problem

Every tool page has a **Report a problem** button at the top. It asks what is wrong and sends it where it can be
fixed:

| You choose | Signed in | Without an account |
| --- | --- | --- |
| It doesn't work | A broken issue | Counted as broken |
| It shows an error | A broken issue, with the error message in a field of its own | Counted as broken; the message needs a sign-in |
| It's out of date | An outdated issue | Counted as out of date, always against the latest version |
| Something on this page is wrong | A wrong-information issue | Needs a sign-in |
| Malware, abuse or a legal problem | A private report to the registry's reviewers | The same; no account needed |

Before you write anything, the page lists the open issues of that kind, so you can add yourself to one with **I have
this problem too** rather than report it again. Take the value you looked up out of any error message you paste.

Without an account a report is only counted. It sends the version (and, for broken, the platform your browser
reports), never any text, and each address counts once a day. When three broken reports of a version come in within
a week, from the website or from `ot`'s failure prompt, the registry opens an issue marked unconfirmed and the
maintainers hear about it. Three out-of-date reports in a week do the same for the latest version, unless the package
already has an open outdated issue; the next version closes it. `ot report <ns/name>` opens the same page.

## Issues

Every package has an **Issues** tab. An issue is one of:

| Kind | For |
| --- | --- |
| Broken | It fails, crashes or returns nothing on a value it should handle |
| Outdated | Upstream has released a newer version than the registry has |
| Wrong information | The page is wrong about inputs, outputs, keys, or what a run contacts |
| Feature request | Something the package should do |
| Question | How to use it, or what a result means |

The form asks for the version, platform, engine (Docker, Podman or `--native`) and exit code as separate fields, so
you never need to paste a command line with your target in it. Use the tool's test input or a made-up value to show
the problem: never personal data about anyone. See the [community guidelines](/policy/community).

An issue moves from **open** to **confirmed** (someone who can triage reproduced it) and then to **fixed**,
**won't fix** or **duplicate**. You can close your own issue as fixed. When a new version is published, open broken
and outdated issues get a note asking whether it fixes them, and unconfirmed out-of-date reports about older versions
are closed.

## Works for me

On a tool page, **It works for me** records that the latest version works on your platform; **It's broken for me**
opens [Report a problem](#report-a-problem) with "It doesn't work" chosen, and **I have this problem too** on an issue
adds you to it. Each person counts once
per version and platform, and the counts from the last 30 days appear in the tool's status line next to the
registry's own nightly health check. They are counts, never ratings.

A new version's first week stands out: the status line says when it came out and what people said since, the tool
page lists the reports by platform next to the counts for the version before it, the versions list and
[What's new](/new) carry them too, and `ot outdated` mentions them when an update is in its first week. When two or
more people say it's broken and they outnumber those who say it works, it is marked as failing, so others can wait,
or pin the version they have.

## Requests

Missing a tool? [Tool requests](/requests) is where people ask for open-source tools to be packaged, and vote for
what others asked for. Ask with the repository's GitHub or GitLab URL and, if you like, a short note on what it finds.
The registry checks it straight away:

- It must be public, and not in the registry already (you get the package's name) or requested already (you can vote
  for that request instead).
- If the project has its own `otinstaller.yaml`, its maintainers can publish it themselves, so it isn't requested.
- A license the registry may not redistribute, or an archived repository, is recorded as declined at once, so the
  next person sees why.
- If [otlite](/otlite) installs the tool already, or the October 2026 seed survey left it out, the request says so.

Triagers then accept a request (it fits: a command-line tool that takes a target and prints results), mark it as
being packaged, or decline it with a reason. When a package from that repository is published, by the community or
by the project's own maintainers, the request is marked published and everyone who voted hears about it. Each account
can make 5 requests and 60 votes a day; the person who asked can withdraw their request, and someone else can ask
for it again later.

Each request has a discussion below it: say why the tool is worth packaging, how you would use it, or what to watch
out for (a login it needs, a license question). Replies are screened and moderated like issue comments. The person who
asked follows the request, and so does anyone who replies or clicks **Follow**; followers hear about new replies and
every decision. Triagers can lock a request's replies, and a request that was published or declined locks by itself
30 days after its last change. A request or a reply can be flagged like any post.

From the terminal: `ot request <repo-url> [--note "..."]`, and `--vote` to vote for an existing request.

## Submissions

Anyone signed in can package an open-source tool they don't maintain, from the [import wizard](/import?community=1)
("Someone else's tool", or **Package it** on a request) or with `ot import --community <repo-url>`. The registry
checks it first: the repository's license must let it be redistributed, it mustn't have its own `otinstaller.yaml`,
and it mustn't be packaged or submitted already. A Python package must come from that repository, according to PyPI.

Then the registry's community bot creates `osintverse-community/<name>` with the manifest and a README crediting the
project, and starts the first release:

- When the project publishes its own image or wheel, the wrapper pins it and the release is a tag.
- Otherwise the wrapper builds an image from a Dockerfile you give. The wizard has templates. A Dockerfile that starts
  from an official base image pinned by tag, runs as a non-root user, downloads nothing into a shell and pins the
  upstream release (`ARG UPSTREAM_VERSION=1.2.3`, `go install ...@v1.2.3`, `pip install tool==1.2.3`) builds straight
  away; anything else waits for a reviewer to read it and start the build. The [errors page](/docs/errors#community-submissions)
  explains each check.

The release is scanned and smoke-tested like any other. Its first version then waits for a community reviewer, never
the person who submitted it, who approves it, asks for changes or turns it down (the wrapper repository is archived,
never deleted). You can change the Dockerfile while it waits or after changes were asked for, and withdraw it. Once it
is published you are listed as its maintainer on the package page. Follow each submission on [/submissions](/submissions).
Each person can have three submissions waiting at a time.

## Keeping community packages current

Every night the registry checks each community wrapper against the project it packages: which release its latest
version pins (read from its Dockerfile, or the wheel it pins on PyPI) and what the project has released since. A tool
page says when the project has released a newer version, or when its repository was archived, removed or relicensed,
and the [community board](/community) lists the wrappers that are behind.

When this is switched on for the registry, a wrapper behind a release for three days gets an **outdated** issue from
the registry, which closes itself once a version pinning that release is published; an archived, removed, renamed or
relicensed upstream gets an issue too. Wrappers pinned to a commit rather than a release are reported, but get no
issue for new commits. Dockerfiles that pin their release in a way the registry can read make this work; the
[errors page](/docs/errors#dockerfile_no_pin) lists the ways.

Further on, the registry's community bot also opens a pull request in the wrapper repository that changes only the
pin: the Dockerfile's pin line, or for a Python package its version and wheel hash. The outdated issue links to it.
The package's maintainers (whoever submitted it, others staff add, and the namespace's members) see **Merge and
release** on the package page: the registry merges the pull request and starts the release, which is built, signed
and scanned like any other. A pull request that changes more than the pin waits for a reviewer. Maintainers can also
triage their package's issues.

The package page then follows the release: published, or failed with the reason (the build, the validation or the
scan) and a link to the workflow run when the build failed. The maintainers get a notification when it fails, and
**Release again** tries once more under a new version after they fix it. The package's version follows upstream's:
2.2 becomes 2.2.0, and a version the package already had gets a patch on top. Bumps are only opened for stable
releases, never for release candidates.

When the registry turns on automatic releases, a pin-only bump is merged and released without a click a week after
upstream's release (and at least four days after the pull request opened), as long as upstream's license still
allows redistribution and the pull request is still open with nothing but the pin changed. The outdated issue and the
package page give the date. A package's maintainers can turn this off, or back on, with the switch beside the bump on
its page; closing the pull request on GitHub stops that one.

### Dependencies and base images

The registry's own first-party tools pin their Python dependencies in `requirements.txt`. Every night each pin is
compared with PyPI's latest release, and the tool page lists the ones behind. When this is switched on, each new
release gets an **outdated** issue after three days, and the community bot opens one pull request updating every
pin that is behind, which a maintainer merges and releases from the package page as a patch version, like a bump
(and which goes out on its own in automatic mode).

Every night the registry also looks up the base image each Docker build in `osintverse-community` starts from (the
Dockerfile's last `FROM`, on Docker Hub). When the image has changed since the latest version was built, and that
version's security scan found critical or high vulnerabilities with a fix available, the registry can rebuild the
package on the newer image: the same source, built, signed and scanned again as a new patch version, so its scan
shows whether the newer base fixed them. It rebuilds a package at most every two weeks, never when something was
merged since the release, and not when its maintainers turned off releases on its own. A rebuild that fails tells
the maintainers, and **Release again** on the package page tries once more.

## Changing a community package

A community package's repository belongs to `osintverse-community`, so its maintainers change more than the pin
through the registry. On the package's **Changes** tab, **Propose a change** opens its `otinstaller.yaml`, Dockerfile
and README as they are on the repository's main branch. Edit them (a new input, a fixed command, clearer ethics
notes, a better Dockerfile, a README that explains the output), say what the change does and why, and the registry:

1. Checks it: the manifest must validate and keep the package's name, namespace, homepage, license and readme (and,
   for a package whose image the release workflow builds, its image); its version is moved past every version the
   package had. The Dockerfile follows the [submission rules](#submissions). Anything that looks like a token or key
   refuses the proposal; anything that looks like personal data is shown to the reviewer.
2. Has the community bot open a pull request in the repository with the changed files.
3. Waits for a staff or community reviewer who isn't you. They approve it, ask for changes (edit the proposal and
   save it again; the pull request follows), or turn it down.
4. On approval, merges the pull request and starts the release, which is built, signed and scanned like any other
   and published when its checks pass.

You hear about each decision in your [notifications](/settings/notifications). Each person can have three proposals
open on a package. Reviewers find what waits for them on the [submissions page](/submissions). Packages published
from their own repository take pull requests there instead.

## From the terminal

When `ot run` fails at a terminal (it timed out, or exited non-zero and found nothing), it asks:

```text
dheeraj/holehe-lite 1.2.0 failed (exit 1). Report it as broken? This sends the tool, version, exit code, OS and ot version, never your inputs or output. [y/N]
```

It asks at most once a week per tool and version, and never from agents (`ot mcp`), scripts without a terminal, CI,
`--json` runs, local manifests, or with `OT_NO_TELEMETRY=1` or `"telemetry": false` in `config.json`. Signed in
(`ot login`), a yes adds you to the version's open broken issue, or opens one. Without a sign-in it only counts, once
per address a day, together with broken reports from the website: when three reports of the same version come in
within a week, the registry opens an issue marked unconfirmed, and someone who can reproduce it confirms it.

| Command | What |
| --- | --- |
| `ot issues <ns/name> [--all]` | The package's open issues (`--all` adds closed ones), so you can check before reporting |
| `ot report <ns/name> --works` | Say the installed version (or `--version X.Y.Z`) works for you; needs a sign-in |
| `ot report <ns/name> --broken` | Say it is broken for you, the same as answering yes to the question |

`ot report --reason broken` still sends a private report to the reviewers; use `--broken` or an issue when other
users should know.

## Notifications

Your inbox at [Settings → Notifications](/settings/notifications) collects replies and status changes on issues you
follow (yours, and ones you replied to, confirmed or chose to follow), new issues on packages you maintain, new
versions of packages whose releases you follow, and moderators' decisions about your posts. Each kind can come by email within 15 minutes, once a day, or not at all;
every email has a one-click unsubscribe link. People get at most a dozen community emails a day; the rest wait for
the next day's digest.

### Following packages, publishers and input types

- **Follow releases** on a tool's page tells you each time a new version becomes its latest.
- **Follow publisher** on a publisher's page tells you the same for every package it publishes, and when it publishes
  a new one.
- **Follow new tools** on an input type's page (for example [/input/domain](/input/domain)) tells you when a new tool
  or guide that takes that type is published. Later versions of it don't count; follow the package for those.

Each comes as an inbox item, and an email as your settings say. An older patch or a release candidate behind the
latest stable version doesn't count. When one release matches several things you follow, you get one item. When you
also follow one of the package's open broken or outdated issues, you hear about the new version on that issue
instead. [Settings → Notifications](/settings/notifications) lists everything you follow; you can follow up to 200
publishers and input types. Nobody else sees what you follow. Without an account, there are Atom feeds of a tool's
releases (`/<namespace>/<tool>/feed.atom`), a publisher's (`/<namespace>/feed.atom`) and an input type's
(`/input/<type>/feed.atom`).

## Profiles

Everyone who takes part has a profile at `/people/<handle>`: their handle, avatar, roles and when they joined, counts
of what they did (issues opened, reports that were confirmed or fixed, replies, "works" and "broken" answers, tools
asked for and published, issues triaged; recounted every night, from posts everyone can see) and their recent issues
and requests. It never shows an email address or the accounts someone signed in with. Handles on issues and requests
link to it. You can hide yours in [Settings → Notifications](/settings/notifications); a hidden profile is not found,
and your avatar is left off your posts.

## Who can do what

| Who | Can |
| --- | --- |
| Anyone | Read issues, the status line, the [community board](/community) and [tool requests](/requests); count a tool as broken or out of date, and report malware or abuse privately |
| Signed in | Open issues, reply, say it works or is broken, follow a thread, flag a post or request, ask for a tool, vote for and reply on requests |
| The package's maintainers | Triage its issues, lock threads, hide comments on its issues; for community packages, merge and release bump pull requests and propose changes |
| Triagers | Triage any package's issues, decide tool requests and lock their replies, approve held posts and requests, hide posts, pause an account for up to 7 days |
| Reviewers | What triagers can, and start, approve, send back or turn down community submissions and change proposals (never their own) |
| Staff | Everything, including redacting posts and granting the triager and reviewer roles |

Triagers and reviewers are community members staff trust; ask at
[OTInstaller/feedback](https://github.com/OTInstaller/feedback) if you would like to help.

## Moderation

To keep spam and personal data out:

- Posts from accounts less than a day old, posts that look like personal data or secrets, and a first post with
  links wait for a moderator.
- Links from people new to the community are shown as text, and every link is marked `nofollow ugc`.
- One personal-data flag from an established account hides a post or request at once; three flags of any kind do the
  same. Moderators see each flag with what it is about and a link to it.
- Each account can post 5 issues a day (2 in its first week), 30 comments, 60 confirmations and 20 flags.
- Issue pages stay out of search engines until a maintainer has answered or the issue is confirmed or fixed.

## For programs

Everything is in the [registry API](/docs/api) (OpenAPI tag "Community"):

| Call | What |
| --- | --- |
| `GET /v1/tools/<ns>/<name>/issues` | A package's issues (`status`, `kind`, `before`) |
| `GET /v1/tools/<ns>/<name>/issues/<number>` | One issue with its replies |
| `GET /v1/tools/<ns>/<name>/status` | The status line, the health history and the confirmation counts; `new_version` in the latest version's first week |
| `GET /v1/issues` | Open problems across the registry (`kind`, `needs=confirmation`) |
| `POST /v1/tools/<ns>/<name>/issues` | Open an issue (token scope `feedback`) |
| `PUT /v1/tools/<ns>/<name>/confirmations` | Works or broken for you (scope `feedback`) |
| `POST /v1/tools/<ns>/<name>/run-reports` | A failed run, as `ot` sends it: `{version, exit_code \| timed_out, os, arch, engine, ot_version}`; anonymous or scope `feedback` |
| `POST /v1/tools/<ns>/<name>/problem-reports` | Broken or out of date without a sign-in, as **Report a problem** sends it: `{kind, version?, platform?}`; only counted. Both report calls refuse a browser's request from another website (`foreign_origin`) |
| `GET /v1/requests` | Tool requests (`status`, `sort=votes\|new`, `before`) |
| `POST /v1/requests` | Ask for a tool (scope `feedback`); `PUT /v1/requests/<number>/vote` to vote |
| `POST /v1/requests/<number>/comments` | Reply on a request (scope `feedback`); `GET /v1/requests/<number>` includes the replies, `PUT .../subscription` follows it |
| `GET /v1/activity?events=community` | Issues confirmed or fixed and tool requests accepted or published, worded from fields (`events=all` adds releases) |
| `GET /v1/upstream/summary` | Community wrappers against their upstream projects: counts by state, and those behind a release |
| `GET /v1/submissions`, `GET /v1/submissions/<number>` | Community submissions and one submission's checks, release and decision |
| `POST /v1/imports/<id>/finish` `{"mode": "submit"}` | Submit a community import (scope `publish`); `dockerfile` and `request` are optional |
| `GET /v1/proposals`, `GET /v1/packages/<ns>/<name>/proposals[/<number>]` | Change proposals across the registry (`status=open\|closed\|all`), a community package's, and one proposal |
| `POST /v1/packages/<ns>/<name>/proposals` | Propose a change: `{title, note, files: {"otinstaller.yaml", "Dockerfile", "README.md"}}` (scope `publish`); `GET /v1/packages/<ns>/<name>/files` gives the files to start from |
| `POST /v1/packages/<ns>/<name>/proposals/<number>/review` | A reviewer's `{decision: approve \| changes_requested \| reject, note}` (scope `manage`) |

Error codes are on the [errors page](/docs/errors#community).
