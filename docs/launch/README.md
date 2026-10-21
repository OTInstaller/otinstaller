# Public launch: Thursday 22 October 2026

**Nothing here has been posted, published or scheduled.** Each post needs the owner's OK before it goes out, one by
one. The posts use the counts from 21 October (37 tools, 10 guides: 8 investigation playbooks and 2 publishing
guides); check them on the morning. The source is public (Apache-2.0) at
https://github.com/OTInstaller/otinstaller.

| File | What |
| --- | --- |
| [on-call-rota.md](on-call-rota.md) | Launch-week on-call rota (22–28 Oct), targets, what to watch, playbooks, hand-over note; the reviewer schedule |
| [demo-video.md](demo-video.md) | Script and shot list for "From an email to 12 accounts in 3 commands" |
| [agent-listings.md](agent-listings.md) | Texts for the Anthropic directory, the Cursor marketplace and connector listings of the agent plugin and MCP servers |
| [posts/osintverse-blog.md](posts/osintverse-blog.md) | Launch post for the OSINTverse blog/Hub (also the basis for the newsletter to OSINTverse users) |
| [posts/product-hunt.md](posts/product-hunt.md) | Name, tagline, description, gallery and maker's comment |
| [posts/show-hn.md](posts/show-hn.md) | Title, first comment, prepared answers |
| [posts/reddit-osint.md](posts/reddit-osint.md) | r/OSINT text post |
| [posts/discord.md](posts/discord.md) | Announcement for OSINT Discord servers, long and one-line |
| [posts/x.md](posts/x.md) | 7-post thread |
| [posts/linkedin.md](posts/linkedin.md) | Company and founder post |

## Still open on launch eve

- **Names on the rota** and the reviewer schedule.
- **The demo video.** If it isn't recorded in time, post without it and add it to the X thread and Product Hunt
  gallery later; the other posts don't depend on it.
- **Beta exit criteria** (10+ external authors, 3+ from GitLab) were not met; launching anyway was the owner's call.
- **Legal review** hasn't happened; the live policies are the current ones, not the drafts on the local branch
  `claude/legal-drafts`.

## Launch-day order (Thursday 22 October)

| Time (UTC) | IST | What | Who |
| --- | --- | --- | --- |
| Wed 21 Oct | | Site and API deployed with the fixes and without the beta strip; `ot` v0.12.1 released; mail to support@ and the other addresses forwarded; rota channel ready | owner, on-call |
| 07:01 | 12:31 | Product Hunt goes live (00:01 Pacific) | maker |
| 07:15 | 12:45 | Blog post published; X thread and LinkedIn posts | community |
| 13:00–14:00 | 18:30–19:30 | Show HN (09:00–10:00 US Eastern) | founder |
| 14:30 | 20:00 | r/OSINT post | founder |
| Afternoon | Evening | Discord servers, after moderators agree | community |
| Fri 23 Oct | | Newsletter to OSINTverse users | owner |

## Fixed on 21 October, while preparing these

- The home page's hero terminal and the getting-started and guides docs used `dheeraj/holehe-lite` and
  `dheeraj/email-investigation-playbook`, which don't exist; they now use `osintverse-community/holehe` and
  `osintverse-community/email-investigation` (the manifest examples use a placeholder namespace, `alice`).
- `ot playbook domain-recon` named `osintverse-community/ctfr`, which isn't on the registry; it now uses
  `osintverse-community/crtsh-subdomains` (ships in `ot` v0.12.1). The migration guide marks the 11 otinstaller tools
  that are packaged in `seed/` but not published yet.
- `https://otinstaller.com/publish` was a 404; it now redirects to the import wizard.
- With the Docker engine stopped, `ot install` ended every error with `: <nil>`; it now says "Docker is installed but
  not running; start Docker Desktop (or Podman)" and exits with code 5.
- The docs said takedown backups are deleted "within 30 days"; the code deletes them after 14.
- The dry-run packages and repositories are gone from public view (see the launch checklist).
