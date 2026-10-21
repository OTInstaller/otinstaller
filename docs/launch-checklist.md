# Launch checklist: closed beta (week 12) and public launch (week 13)

State as of **21 October 2026**, from a readiness audit and a dry run on production. Branch
`claude/week12-beta-7d9771` holds the fixes and beta tools below. Items marked **(you)** need the owner of the
GitHub, GitLab, Cloudflare, Resend or osintverse.com accounts.

**Beta exit criteria** (plan, week 12): 10+ external authors have published, at least 3 from GitLab; no open
severity-1 bugs; `ot` installs cleanly on Windows, macOS and Linux. The admin console's **Beta** tab
(https://otinstaller.com/admin/beta) tracks the first two.

## Blocking the beta

These stop testers on day one. Don't send invitations until they are done.

| # | Item | State | What it needs |
|---|------|-------|---------------|
| 1 | **`ot` has never been released.** No `OTInstaller/ot` release repository, no tags, no Homebrew tap or Scoop bucket, and `get.otinstaller.com` doesn't resolve, so every install command in the docs fails. | Release workflow and GoReleaser config exist. `ops/get/` (new) serves the install scripts at get.otinstaller.com. The install scripts are tested end to end on Windows here and in a Linux container; `.github/workflows/cli-install.yml` (new) covers Linux, macOS and Windows on CI. | **(you)** Create the public repo `OTInstaller/ot`. Generate the release key (docs/publishing-setup.md §10) and set secret `OT_RELEASE_KEY`, secret `RELEASE_GITHUB_TOKEN` (contents: write on `OTInstaller/ot`) and variable `OT_RELEASE_PUBLIC_KEY` on `OTInstaller/otinstaller`. Optional: create `OTInstaller/homebrew-tap` and `OTInstaller/scoop-bucket` plus secret `TAP_GITHUB_TOKEN`. Push a **non-prerelease** tag such as `v0.12.0` (the install scripts and `ot self-update` use GitHub's "latest release", which skips prereleases). Then deploy `ops/get` (`cd ops/get && npx wrangler deploy`; it creates the DNS record). |
| 2 | **Email doesn't send.** Resend answers `401 API key is invalid`; 79 notifications failed since 20 Oct (publish, reject, review, archive), one was ever sent. Authors get no "published" or "rejected" mail and reviewers no alerts. | Code is fine; the secret is wrong or revoked. | **(you)** In Resend, check `otinstaller.com` is a verified domain and create an API key with send access, then `cd api && npx wrangler secret put RESEND_API_KEY`. Failed notifications are not retried. |
| 3 | **Testers can't file issues.** `OTInstaller/otinstaller` is private, so the bug-report link on the site and in `ot feedback` 404s for anyone outside the org, and the admin console can't count sev-1 issues. | Issue forms with a severity field, a labeller workflow and `scripts/beta/labels.sh` are on this branch. | **(you)** Pick one: make `OTInstaller/otinstaller` public, **or** (recommended while the source stays private) create a public `OTInstaller/feedback` repository, copy `.github/ISSUE_TEMPLATE/` and `.github/workflows/issue-severity.yml` into it, run `sh scripts/beta/labels.sh OTInstaller/feedback`, set the API var `ISSUES_REPO=OTInstaller/feedback` and build the site with `PUBLIC_ISSUES_URL=https://github.com/OTInstaller/feedback/issues`. |
| 4 | **GitLab publishing was impossible.** Found in the dry run: (a) the GitLab OAuth app lacked the `api` scope, so connecting a project failed at GitLab; (b) all three GitLab release templates were invalid YAML; (c) they needed a project access token, which is paid-only on GitLab.com; (d) new GitLab.com projects can't set pipeline variables, so "run a pipeline with VERSION" didn't work; (e) arm64 images couldn't build without QEMU; (f) the registry set GitLab's commit status to `running` twice and GitLab's 400 failed the job, rejecting every GitLab release. | (a) fixed on the app (21 Oct) and in the setup guide; (b)–(f) fixed on this branch (`165961e`, `0df6d53`, `d9a19a0`) and **deployed** (`d9a19a0`, 21 Oct). | **(you)** Rename the GitLab application from "OTInstaller (staging)" to "OTInstaller" (authors see the name on the consent screen) and drop the staging and 127.0.0.1 callbacks, or register a separate production app. |
| 5 | **Production was down** most of 21 Oct: crawlers walking every search filter combination used up D1's free daily reads, and every page answered 500 or 404. | Fixed and deployed (`2821b22`, `1bd47e4`): edge cache for anonymous API reads, nofollow and noindex on filtered views, `Disallow: /*?`, a 500 page. You moved the account to Workers Paid. | Nothing. Watch D1 reads in the Cloudflare dashboard for a few days. |

## Not merged or not deployed

| Item | State | What it needs |
|------|-------|---------------|
| This branch (`claude/week12-beta-7d9771`) | Production runs `90b9c2c`: main (weeks 1–11, PR #3, PR #4) plus all of week 12; migrations up to 0012 applied. Only docs were committed after it. | **(you)** Push, open a PR, merge to main. The CI install matrix runs on the PR. **Don't deploy main until week 11's resources exist** (next row): its `wrangler.jsonc` binds R2 buckets that aren't created yet. |
| Week 11 backups ([PR #3](https://github.com/OTInstaller/otinstaller/pull/3), merged into main 21 Oct) | Merged into this branch too (conflicts resolved; API 278/278). Not deployed. Migration `0011_backups.sql` applies cleanly after `0012_feedback.sql` (D1 applies whichever is missing). | **(you)** R2 buckets `otinstaller-backups` and `otinstaller-mirror`; an R2 API token (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`); `MIRROR_PUSH_TOKEN` on the mirror Worker and in registry-ops; deploy the mirror Worker (`wrangler.mirror.jsonc`, creates mirror.otinstaller.com; Workers Paid is now on); `npx wrangler d1 migrations apply otinstaller --remote` for 0011; copy `ops/scanner/backup.py` and `ops/workflows/scan.yml` into registry-ops. Not needed for the beta to start; needed before launch per the plan. |
| PR #2 (Python package manager merge) | Merged into main on 20 Oct (`6b8f6a6`). Deployed with this branch. | Nothing. |
| Site docs that went live "at the next deploy" | Live since today's deploy. | Nothing. |
| API `total` on `/v1/tools` and `/v1/guides` | Live (`/v1/tools?kind=tool` total 38, `/v1/guides` total 10). | Nothing. |

## Production checks (21 October 2026)

| Check | Result |
|-------|--------|
| API `api.otinstaller.com` | OK after the fix: `/v1/health`, `/v1/tools`, `/v1/guides`, tool and manifest reads. Edge cache confirmed (`x-edge-cache: hit`). |
| Site `otinstaller.com` | OK: home, search, tool pages, docs, guides, `/feedback`, `/admin/beta`, `robots.txt`. The beta strip shows on every page. |
| Sign-in | GitHub OK (existing session), GitLab OK (linked `osintversehq`), OSINTverse linked. |
| Scanner (registry-ops `scan` workflow) | OK: 53 runs, latest succeeded; `dheerajydv19/ot-test-tool` 0.3.6 was scanned and published about 70 s after its tag. |
| Sentry | `SENTRY_DSN` is set. Not verified from here (no Sentry access). **(you)** Check that the 500s from 21 Oct 05:00–11:00 UTC arrived. |
| Email (Resend) | **Broken**, see blocker 2. |
| Health checks | `HEALTH_TOKEN` set; nightly workflow in registry-ops. Not re-run today. |
| Staging (`staging-api.otinstaller.com`) | Down (Cloudflare tunnel not running). Not needed: the dry run used production. |
| Feedback | `ot feedback` and the site form both store to D1 on production; visible at /admin/feedback. |

## Dry run on production (21 October 2026)

| Step | GitHub (`dheerajydv19/ot-test-tool`) | GitLab (`osintversehq/ot-test-tool`) |
|------|-----------------------------------|-------------------------------------|
| Sign in / connect | Existing App installation | Linked GitLab; connect failed until the `api` scope was added to the app, then OK |
| Release | `otinstaller release` workflow, v0.3.6, 1 min 30 s | Fixed template, no token, no variables: v0.1.0 and v0.1.1 built (amd64 + arm64 under QEMU), signed with GitLab OIDC, tagged by the job token (~8 min each); v0.1.2 tagged from git |
| Validate → scan → publish | Published, scans pass, signed, ~70 s after the tag | v0.1.0/v0.1.1 rejected by the commit-status bug (fixed in `d9a19a0`); v0.1.2 validated in 13 s, all five scans pass |
| Review | Not needed (namespace already approved) | Approved in the admin console 07:22:58 UTC; v0.1.2 published 7 s later from the queue |
| `ot install` / `ot run` on Windows | OK: cosign signature verified, `ot run … d:example.com` exit 0 | OK: GitLab OIDC signature on `registry.gitlab.com/osintversehq/ot-test-tool` verified, `ot run … d:example.com` exit 0 |

Production deploys on 21 Oct: `8556684` (06:14 UTC), `d9a19a0` (06:55), then week 11's `claude/backup-backfill` from another session (07:01, which dropped the beta work), then `c242065` = main with week 11 + this branch (07:10). Then `90b9c2c` (adds PR #4, the backup backfill) at about 07:20 UTC, which is what production runs now.

## Install matrix

| Platform | How | Result |
|----------|-----|--------|
| Windows 11 (amd64) | `irm …/install.ps1 \| iex` against a signed local release | OK: signature verified, installed, `ot search`/`info` against production; with Docker running, `ot install` + `ot run` OK |
| Linux (amd64, Debian container) | `curl …/install.sh \| sh` | OK; a tampered `checksums.txt` is refused |
| Linux (amd64, arm64), macOS (Apple silicon), Windows | `.github/workflows/cli-install.yml` | Runs on the PR (needs pushing). macOS runs with the system PATH: `install.sh` now falls back to checksum-only with a warning when only LibreSSL is present, where it used to fail |
| macOS Intel, Windows arm64 | not covered | GitHub's Intel macOS and Windows arm64 runners aren't available for this private repository; check by hand if a tester has one |

## Beta decisions

- **No invite gate.** Every new namespace already waits in the review queue for a reviewer, so only approved
  people can publish. Approve the invited authors' namespaces; reject others politely until launch.
- **Feedback** goes to D1 (`/admin/feedback`); bugs that block someone also go to GitHub issues with a severity,
  which the Beta tab counts.

## Before the public launch (week 13)

- [ ] Beta exit criteria met (Beta tab), survey read ([beta/feedback-survey.md](beta/feedback-survey.md)).
- [ ] Week 11 backups merged and deployed; restore drill run once.
- [ ] Build the site with `PUBLIC_BETA=0` to drop the beta strip.
- [ ] Yank the dry-run packages (`ot yank dheerajydv19/ot-test-tool@0.3.6`, `osintversehq/ot-test-tool`), or
      remove them in the admin console.
- [ ] Resubmit the sitemap in Google Search Console (crawlers saw 404s and 500s on 21 Oct).
- [ ] On-call rota for launch week; launch posts (plan, week 13).
