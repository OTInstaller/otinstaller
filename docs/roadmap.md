# Roadmap

OTInstaller should be the place people go to learn about, use, manage and keep up with open-source OSINT tools, and
the community should be what keeps it current. People who use a tool are the first to know when it breaks, when its
upstream ships a new version, or when a good tool is missing. This roadmap is about giving them the means to say so,
and making sure what they say reaches someone who can act on it.

Written in October 2026 from a review of the code. Each item lands as its own pull request; this page is updated
when a phase changes. Production steps (migrations, deploys, releases) happen separately, after review.

## Where things stand

- **Using tools is strong.** Typed inputs, sandboxed runs, saved results, pivots, playbooks and agents (`ot mcp`)
  all work.
- **Contributions only flow inward.** Reports and feedback are private and the sender never hears back. Only the
  `osintverse-community` maintainers can package someone else's tool. Nightly health checks are the only signal
  that a tool broke.
- **Nothing tells a user that something changed.** There are no feeds. Release notes are stored but never shown.
  Nothing watches the upstream projects that community wrappers package, so wrappers fall behind.
- **Learning material is thin.** There are eight investigation guides, but no primer on method, opsec or the law,
  and no way to compare the tools that take the same input.

## Phase 1: the community loop

Built on 23 October 2026 as pull requests; not merged or deployed yet ([launch-checklist.md](launch-checklist.md)
lists the owner's steps). Left from phase 1: a request's discussion thread, flags on requests, maintainers proposing
changes beyond a pin, and highlighting a new version's works/broken counts for its first week.

**Community**
- Issues and discussion on every tool page: broken, outdated, wrong information, feature requests and questions,
  with comments, "me too", status and subscriptions. Moderation and community guidelines come with them.
- A community status line on each tool, combining the nightly health check, its history, and "works for me" or
  "broken for me" confirmations by version and platform. These are factual counts, not ratings.
- Tool requests: anyone signed in can ask for a tool by its repository, with licence and duplicate checks; others
  upvote.
- Community submissions: anyone signed in can package someone else's open-source tool through the import wizard.
  A staff or community reviewer approves its first release.
- `ot` offers to report a run that failed through the tool's fault. It sends the tool, version, exit code, OS and
  `ot` version, never inputs or output. It never asks agents or scripts, and is off when telemetry is off.
- Triager and reviewer roles for trusted community members, contributor profiles, and email notifications people
  can switch off.

**Staying updated**
- Release notes captured at publish time and shown on tool pages, version pages and in `ot`.
- A site-wide activity feed: Atom and JSON feeds for the whole registry, each publisher, each tool and each input
  type, plus a "What's new" page.
- An upstream watcher that notices new upstream releases and archived projects. It files "outdated" issues, and
  later proposes the version bump.
- `ot outdated` flags installed tools that are deprecated, possibly broken or yanked, and says when a newer `ot`
  exists.

**Learning**
- A `/learn` hub: how an investigation runs (scope, collect, pivot, verify, record, report), opsec for the
  investigator, legal and ethical basics, and a reading order through the guides.
- A comparison table on each input page: what each tool finds, whether it needs a key, whether it contacts the
  target, and its health.
- A draft "OSINT fundamentals" guide.

**Using and managing**
- `ot install a b c`, with a next-step hint after installing.
- Email, phone and IP playbooks alongside the domain and username ones.
- On a fresh machine, `ot auto` and playbooks offer to install a starter set instead of failing.
- `ot runs` to list and open saved runs.

Stars are no longer shown or offered as a sort until starring exists (phase 2).

## Phase 2

- Star and follow tools, publishers and input types, with a weekly digest.
- Deleting your account and your contributions.
- Packaging the tools that only the no-Docker edition (otlite) has today, through community submissions.
- Guides for names, companies, hashes and breach data; the first advanced guides; playbook pages on the site.
- Release workflows that create a GitHub release with notes.

## Phase 3

- Case management in `ot`: notes, tags, a timeline and a report you can share.
- Running the suggested pivots with consent, resuming interrupted batches, and a local viewer for results.
- One catalog shared by `ot` and otlite.

## Phase 4

- Public statistics and trending tools, and a weekly "new tools" post generated from the activity feed.
- The remaining trust gaps listed in AGENTS.md.

Suggestions are welcome through `ot feedback`, [otinstaller.com/feedback](https://otinstaller.com/feedback), or
issues on [OTInstaller/feedback](https://github.com/OTInstaller/feedback).
