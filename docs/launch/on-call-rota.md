# Launch week: on-call rota and reviewer schedule (template)

Fill in the names and dates, then share it with everyone on it. Keep phone numbers and personal contact details in a
private document, not in this repository. "Day 0" is launch day, Thursday 22 October 2026; the week runs Day 0 to Day 6, then the normal
reviewer rota takes over.

## Roles

| Role | Covers | Needs |
| --- | --- | --- |
| **On-call engineer** (primary, secondary) | Site, API, mirror, get.otinstaller.com, the scanner in registry-ops, email delivery, `ot` releases | Cloudflare (Workers, D1, R2, DNS), `wrangler` logged in, GitHub admin on `OTInstaller/*`, Sentry, Resend |
| **Reviewer** | Review queue (new namespaces), reports, takedowns, claims | Reviewer role on otinstaller.com (`is_reviewer`), GitHub 2FA |
| **Community** | Replies on Hacker News, Product Hunt, Reddit, Discord, X, LinkedIn; the feedback inbox; GitHub issues on `OTInstaller/feedback` | The launch posts in [posts/](posts/), the FAQ at https://otinstaller.com/docs/faq |

One person can hold two roles on a small team, but not on-call engineer and community at the same time on Day 0:
both peak in the first hours.

## Targets for launch week

Tighter than the published policy ([takedown policy](https://otinstaller.com/policy/takedown): 24 hours for
malware, 72 hours for other reports), because launch traffic brings the first strangers.

| Event | Acknowledge | Act |
| --- | --- | --- |
| Site or API down, or `/v1/health` failing | 15 minutes | Mitigate within 1 hour |
| Malware or credible-harm report | 1 hour | Remove the version at once if there is evidence (any reviewer); second reviewer confirms after |
| Other reports (policy, impersonation, license, broken) | 4 hours | Decide within 24 hours |
| New namespace waiting for review | — | Same day; never more than 48 hours (plan's target median) |
| Copyright, legal or government request | Same day | Forward to the owner; don't act alone unless it is clearly valid (see the takedown policy) |
| Questions on launch threads | 1 hour while the post is on the front page | — |

## Rota

Two overlapping shifts cover India daytime and the US morning, when Hacker News and Product Hunt traffic peaks.
Adjust to where the team is.

| Day | Date | Shift A, 03:30–15:30 UTC (09:00–21:00 IST) | Shift B, 13:00–01:00 UTC (09:00–21:00 US Eastern) | Reviewer | Community |
| --- | --- | --- | --- | --- | --- |
| Day 0 (launch) | Thu 22 Oct | {name} | {name} | {name} | {name} |
| Day 1 | Fri 23 Oct | {name} | {name} | {name} | {name} |
| Day 2 (weekend) | Sat 24 Oct | {name} | best effort | {name} | best effort |
| Day 3 (weekend) | Sun 25 Oct | {name} | best effort | {name} | best effort |
| Day 4 | Mon 26 Oct | {name} | {name} | {name} | {name} |
| Day 5 | Tue 27 Oct | {name} | {name} | {name} | {name} |
| Day 6 | Wed 28 Oct | {name} | {name} | {name} | {name} |

Outside both shifts nobody is on call. Say so in the launch posts' FAQ answers ("we're a small team; reports are
answered within a day") rather than promise 24/7.

**Escalation:** on-call engineer → {owner name} (decides on outages, legal requests, bans and anything public about
an incident). Contact details: {link to the private contact sheet}.

## Before Day 0 (everyone on the rota)

- [ ] Signed in to https://otinstaller.com/admin with the right role; GitHub 2FA on.
- [ ] Engineers: `npx wrangler whoami` shows the OTInstaller Cloudflare account; access to Sentry and Resend; can run
      `gh run list -R OTInstaller/registry-ops`.
- [x] Mail to support@, privacy@, abuse@, security@, legal@ and dmca@otinstaller.com forwards to hi@osintverse.com
      (set up and tested 21 Oct). Whoever reads that inbox during launch week must watch for these.
- [ ] Email notifications are being delivered (Resend key fixed; check below).
- [ ] Everyone has read this page and the [takedown policy](https://otinstaller.com/policy/takedown).
- [ ] A shared chat channel for the rota, and this page pinned in it.

## What to watch, and where

Check at the start of each shift and every couple of hours on Day 0 and Day 1.

| What | Where | Bad sign |
| --- | --- | --- |
| API health | `curl https://api.otinstaller.com/v1/health` | Not 200 |
| Errors | Sentry, project for `otinstaller-registry-api` | New error types, or 5xx bursts |
| Live logs | `cd api && npx wrangler tail otinstaller-registry-api` | Repeated exceptions |
| D1 reads and Worker requests | Cloudflare dashboard → Workers & Pages → `otinstaller-registry-api`; D1 → `otinstaller` → Metrics | A steep climb (on 21 Oct crawlers used up the daily D1 reads; the edge cache now absorbs anonymous reads, `x-edge-cache: hit`) |
| Publishing pipeline | `gh run list -R OTInstaller/registry-ops -L 20` (workflow `scan`) | Failed or queued runs piling up; the admin console's **Beta** tab "Failed publishes" |
| Review queue and reports | https://otinstaller.com/admin (Review queue, Reports, Claims) | Anything older than the targets above |
| Feedback | https://otinstaller.com/admin/feedback | Bugs that block people: open a GitHub issue with a severity |
| Severity-1 bugs | https://github.com/OTInstaller/feedback/issues?q=is%3Aopen+label%3Asev-1 | Any |
| Email delivery | D1: `SELECT status, COUNT(*) FROM notifications WHERE created_at > (strftime('%s','now')-86400)*1000 GROUP BY status` | `failed` rows |
| Mirror | `curl -i https://mirror.otinstaller.com/v2/` | Not 401 with a Bearer challenge |
| Installers | `curl -sI https://get.otinstaller.com/ot` and `…/ot.ps1` | Not 200 |
| Backups | D1: `SELECT kind, status, COUNT(*) FROM backups GROUP BY kind, status` | `failed` growing |

## Playbooks

**Site or API down.** Check `/v1/health` and Sentry. If a deploy caused it, roll back:
`cd api && npx wrangler rollback` (or the site's Worker, `otinstaller-registry-web`). If D1 reads are exhausted or a
crawler is hammering filtered pages, confirm the edge cache is on and `robots.txt` still disallows `/*?`; block the
abusive user agent with a Cloudflare WAF rule. Post a short status note in the launch threads if it lasts more than 15
minutes.

**Malware or credible harm.** Follow the plan's steps: remove the version in the admin console (Reports → Take down,
or the version's page), which stops `ot` resolving it and warns anyone who installed it; suspend the namespace if the
publisher is malicious; a second reviewer confirms; publish an advisory; write a post-incident review within 7 days.

**Spam or abusive namespaces.** New namespaces wait in the review queue, so nothing they publish goes live. Reject them;
ban the account (admin) if it keeps coming back.

**Doxxing, a guide or tool aimed at a private person.** Remove at once (category `policy`), then tell the owner.

**Scanner backlog.** Look at the `scan` workflow runs in registry-ops; GitHub Actions concurrency is the usual limit.
Stuck jobs older than 30 minutes are emailed to admins every 15 minutes.

**Email not sending.** Check the `notifications` query above and Resend's dashboard. Failed notifications are not
retried; tell affected authors by hand if a publish or review email was lost.

**Press, legal or government contact.** Don't reply on the spot. Forward to {owner name}.

## Hand-over note (end of each shift)

Post in the rota channel:

```
Shift {A/B}, Day {n}, {date}
Status: {all clear | degraded: …}
Open: {incidents, reports waiting, namespaces waiting, sev-1 issues}
Done: {what was handled}
Watch: {anything the next shift should look at first}
```

---

# Reviewer schedule (template)

Reviewers work through https://otinstaller.com/admin. Every new namespace's first release waits for a person; reports
and claims also land here. Reviewers get a daily digest of namespaces waiting more than 2 business days and reports
older than 48 hours.

## Launch week

| Day | Morning check (by 06:00 UTC) | Midday check (by 12:00 UTC) | Evening check (by 18:00 UTC) | Second reviewer for takedowns |
| --- | --- | --- | --- | --- |
| Day 0, Thu 22 Oct | {name} | {name} | {name} | {name} |
| Day 1, Fri 23 Oct | {name} | {name} | {name} | {name} |
| Day 2, Sat 24 Oct | {name} | — | {name} | {name} |
| Day 3, Sun 25 Oct | {name} | — | {name} | {name} |
| Day 4, Mon 26 Oct | {name} | {name} | {name} | {name} |
| Day 5, Tue 27 Oct | {name} | {name} | {name} | {name} |
| Day 6, Wed 28 Oct | {name} | {name} | {name} | {name} |

## After launch week (weekly)

| Week of | Primary reviewer | Backup reviewer | Notes |
| --- | --- | --- | --- |
| 2 Nov | {name} | {name} | |
| 9 Nov | {name} | {name} | |
| 16 Nov | {name} | {name} | |
| 23 Nov | {name} | {name} | |

Target: median new-namespace review under 48 hours, first response to reports under 48 hours (plan, first 90 days).
The plan also calls for a second trained reviewer by month 2.

## Each check

1. **Review queue.** For each new namespace: the GitHub or GitLab profile (account age, other repositories), the
   manifest, README, scan reports, SBOM and the ethics answers. Approve, request changes (say exactly what), or
   reject with the policy reason. Check the acceptable use policy's "Not allowed" list and that ethics answers match
   what the code does (does it log in? contact the target? collect personal data?).
2. **Reports.** Act or dismiss with a note; malware with evidence is removed at once.
3. **Claims** of community wrappers: verified claims go to an admin to complete.
4. **Guides** held for possible personal data in examples: the lines are highlighted; ask for fictional data.
5. Log anything unusual in the rota channel.
