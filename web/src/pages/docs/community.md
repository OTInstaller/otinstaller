---
layout: ../../layouts/Docs.astro
title: Community
description: Issues, "works for me", triage and moderation, and the API behind them.
---

The people who run a tool are the first to know when it breaks, falls behind its upstream, or says something
untrue. The registry gives them a place to say so, in public, where maintainers and other users can see and act on
it. Reading everything needs no account; taking part needs a GitHub, GitLab or OSINTverse sign-in.

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
and outdated issues get a note asking whether it fixes them.

## Works for me

On a tool page, **It works for me** records that the latest version works on your platform; **It's broken for me**
takes you to a new broken issue, and **I have this problem too** on an issue adds you to it. Each person counts once
per version and platform, and the counts from the last 30 days appear in the tool's status line next to the
registry's own nightly health check. They are counts, never ratings.

## Notifications

Your inbox at [Settings → Notifications](/settings/notifications) collects replies and status changes on issues you
follow (yours, and ones you replied to, confirmed or chose to follow), new issues on packages you maintain, and
moderators' decisions about your posts. Each kind can come by email within 15 minutes, once a day, or not at all;
every email has a one-click unsubscribe link. People get at most a dozen community emails a day; the rest wait for
the next day's digest.

## Who can do what

| Who | Can |
| --- | --- |
| Anyone | Read issues, the status line and the [community board](/community) |
| Signed in | Open issues, reply, say it works or is broken, follow a thread, flag a post |
| The package's maintainers | Triage its issues, lock threads, hide comments on its issues |
| Triagers | Triage any package's issues, approve held posts, hide posts, pause an account for up to 7 days |
| Reviewers | What triagers can, and approve community submissions' first releases |
| Staff | Everything, including redacting posts and granting the triager and reviewer roles |

Triagers and reviewers are community members staff trust; ask at
[OTInstaller/feedback](https://github.com/OTInstaller/feedback) if you would like to help.

## Moderation

To keep spam and personal data out:

- Posts from accounts less than a day old, posts that look like personal data or secrets, and a first post with
  links wait for a moderator.
- Links from people new to the community are shown as text, and every link is marked `nofollow ugc`.
- One personal-data flag from an established account hides a post at once; three flags of any kind do the same.
- Each account can post 5 issues a day (2 in its first week), 30 comments, 60 confirmations and 20 flags.
- Issue pages stay out of search engines until a maintainer has answered or the issue is confirmed or fixed.

## For programs

Everything is in the [registry API](/docs/api) (OpenAPI tag "Community"):

| Call | What |
| --- | --- |
| `GET /v1/tools/<ns>/<name>/issues` | A package's issues (`status`, `kind`, `before`) |
| `GET /v1/tools/<ns>/<name>/issues/<number>` | One issue with its replies |
| `GET /v1/tools/<ns>/<name>/status` | The status line, the health history and the confirmation counts |
| `GET /v1/issues` | Open problems across the registry (`kind`, `needs=confirmation`) |
| `POST /v1/tools/<ns>/<name>/issues` | Open an issue (token scope `feedback`) |
| `PUT /v1/tools/<ns>/<name>/confirmations` | Works or broken for you (scope `feedback`) |

Error codes are on the [errors page](/docs/errors#community).
