# Launch checklist: closed beta (week 12) and public launch (week 13)

State as of **21 October 2026**, from a readiness audit and a dry run on production. Branch
`claude/week12-beta-7d9771` holds the fixes and beta tools below. Items marked **(you)** need the owner of the
GitHub, GitLab, Cloudflare, Resend or osintverse.com accounts.

**Beta exit criteria** (plan, week 12): 10+ external authors have published, at least 3 from GitLab; no open
severity-1 bugs; `ot` installs cleanly on Windows, macOS and Linux. The admin console's **Beta** tab
(https://otinstaller.com/admin/beta) tracks the first two.

## Blocking the beta

These stop testers on day one. Don't send invitations until they are done. **All done as of 21 Oct**; the
invitations can go out.

| # | Item | State | What it needs |
|---|------|-------|---------------|
| 1 | **`ot` has never been released.** No `OTInstaller/ot` release repository, no tags, no Homebrew tap or Scoop bucket, and `get.otinstaller.com` doesn't resolve, so every install command in the docs fails. | Release workflow and GoReleaser config exist. `ops/get/` (new) serves the install scripts at get.otinstaller.com. The install scripts are tested end to end on Windows here and in a Linux container; `.github/workflows/cli-install.yml` (new) covers Linux, macOS and Windows on CI. **Done (21 Oct):** `ot` v0.12.0 is the latest release on `OTInstaller/ot`; `get.otinstaller.com` is deployed. Verified against the published release: `irm https://get.otinstaller.com/ot.ps1 \| iex` on Windows 11 and `curl -fsSL https://get.otinstaller.com/ot \| sh` in a Debian container both install with "Signature verified"; `ot --version`, `ot self-update` ("v0.12.0 is the latest release") and `ot search` against production work on both. | Nothing for the beta. Later: Homebrew tap and Scoop bucket (`TAP_GITHUB_TOKEN`); the install docs hide them until then. |
| 2 | **Email doesn't send.** Resend answers `401 API key is invalid`; 79 notifications failed since 20 Oct (publish, reject, review, archive), one was ever sent. Authors get no "published" or "rejected" mail and reviewers no alerts. | Code is fine; the old key had been deleted in Resend. **Done (21 Oct):** `otinstaller.com` is verified in Resend (no DNS changes needed); new key `otinstaller-api` (sending access, otinstaller.com only) set with `wrangler secret put RESEND_API_KEY`. New admin endpoint `POST /v1/admin/email-test` (mails the calling admin, answers with Resend's error on failure) deployed; its test email showed "Delivered" in Resend. | Nothing. The 81 notifications that failed on 20–21 Oct are **not** re-sent (decided 21 Oct: stale). |
| 3 | **Testers can't file issues.** `OTInstaller/otinstaller` is private, so the bug-report link on the site and in `ot feedback` 404s for anyone outside the org, and the admin console can't count sev-1 issues. | Issue forms with a severity field, a labeller workflow and `scripts/beta/labels.sh` are on this branch. **Done (21 Oct):** public `OTInstaller/feedback` has the issue forms, `issue-severity.yml` and the beta labels (`sev-1`–`sev-3`, `beta`, `needs-triage`, `area:*`). The API and site default to it (`60ea168`, deployed), so no `ISSUES_REPO`/`PUBLIC_ISSUES_URL` override is needed. Verified: production `/feedback` links to `github.com/OTInstaller/feedback/issues`; `ot feedback` without a message opens that page. | Nothing. |
| 4 | **GitLab publishing was impossible.** Found in the dry run: (a) the GitLab OAuth app lacked the `api` scope, so connecting a project failed at GitLab; (b) all three GitLab release templates were invalid YAML; (c) they needed a project access token, which is paid-only on GitLab.com; (d) new GitLab.com projects can't set pipeline variables, so "run a pipeline with VERSION" didn't work; (e) arm64 images couldn't build without QEMU; (f) the registry set GitLab's commit status to `running` twice and GitLab's 400 failed the job, rejecting every GitLab release. | (a) fixed on the app (21 Oct) and in the setup guide; (b)–(f) fixed on this branch (`165961e`, `0df6d53`, `d9a19a0`) and **deployed** (`d9a19a0`, 21 Oct). **Done (21 Oct):** the GitLab application is now "OTInstaller" with only `https://api.otinstaller.com/v1/auth/gitlab/callback`. Verified: web sign-in with GitLab reaches the dashboard, and `ot login --gitlab` (device grant, consent screen says "OTInstaller") signs in. | Nothing. Local development needs its own GitLab app now (the 127.0.0.1 callback is gone). |
| 5 | **Production was down** most of 21 Oct: crawlers walking every search filter combination used up D1's free daily reads, and every page answered 500 or 404. | Fixed and deployed (`2821b22`, `1bd47e4`): edge cache for anonymous API reads, nofollow and noindex on filtered views, `Disallow: /*?`, a 500 page. You moved the account to Workers Paid. | Nothing. Watch D1 reads in the Cloudflare dashboard for a few days. |

## Not merged or not deployed

| Item | State | What it needs |
|------|-------|---------------|
| This branch (`claude/week12-beta-7d9771`) | Production runs `90b9c2c`: main (weeks 1–11, PR #3, PR #4) plus all of week 12; migrations up to 0012 applied. Only docs were committed after it. **Done:** merged as [PR #5](https://github.com/OTInstaller/otinstaller/pull/5) (21 Oct, `ot install` matrix green), followed by PRs #6–#12; main's `ot install` workflow is green. Week 11's resources exist (checked 21 Oct): R2 buckets `otinstaller-backups` and `otinstaller-mirror`, the `otinstaller-mirror` Worker (mirror.otinstaller.com answers `/v2/` with 401 as expected) with `MIRROR_PUSH_TOKEN`, the `R2_*` secrets on the API, and migrations 0011 and 0012 applied remotely. | Nothing. |
| Week 11 backups ([PR #3](https://github.com/OTInstaller/otinstaller/pull/3), merged into main 21 Oct) | **Live** (checked 21 Oct, see "Backups and restore drill" below): both R2 buckets, the R2 token secrets and `MIRROR_PUSH_TOKEN` on the API, the mirror Worker at mirror.otinstaller.com, migration 0011 applied remotely, and `backup.py`, `scan.py` and `scan.yml` in registry-ops identical to this repo. | Nothing. |
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
| Email (Resend) | OK since the new key (blocker 2): test email delivered 21 Oct. |
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

## Backups and restore drill (21 October 2026)

Checked before changing anything; nothing needed creating.

| Item | State |
|------|-------|
| R2 buckets `otinstaller-backups`, `otinstaller-mirror` | Exist (created 21 Oct 06:41 UTC) |
| API secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Set on `otinstaller-registry-api` |
| `MIRROR_PUSH_TOKEN` | Set on `otinstaller-mirror` and in registry-ops |
| Mirror Worker | Deployed; `https://mirror.otinstaller.com/v2/` answers 401 with a Bearer challenge |
| Migration 0011 | Applied remotely (after 0012) |
| registry-ops | `ops/scanner/backup.py`, `ops/scanner/scan.py`, `.github/workflows/scan.yml` match this repo byte for byte; recent `otinstaller-backup` runs succeed |
| Coverage | Every published tool version has a stored git bundle and its image or wheel: 49 bundles, 32 images, 12 wheels. 6 git uploads failed at about 07:30 UTC (`SignatureDoesNotMatch`, before the R2 token was fixed, and one GitLab 403); all were retried and stored later. |
| Automatic drill | `otinstaller-drill` at 07:58 UTC: bundle pass (10 refs), image pass, signature verified |

**Drill by hand** (against production, `osintverse-community/image-hash` 0.1.0):

1. *Back up.* `POST /v1/admin/tools/osintverse-community/image-hash/0.1.0/backup` answered `nothing_to_do`: the release
   bundle and image were already stored by the scan job.
2. *Restore the git bundle into an empty repository.* Downloaded `git/github/1427216588/2026-10-21-v0.1.0.bundle` from
   R2: SHA-256 `6b7c52b9…f748495` matches the record, `git bundle verify` OK, `git clone --mirror` then
   `git push --mirror` into a new bare repository, `git fsck --full` clean, refs (`main`, `v0.1.0` at `e1b8149`)
   identical to GitHub's. (The owner's **Restore from backup** link wasn't requested in this run; the bundle came
   straight from R2.)
3. *Pull the mirrored image by digest with the signature verified.* `docker pull
   mirror.otinstaller.com/osintverse-community/image-hash@sha256:588a79f1…` then `cosign verify` with the recorded
   signer (`…/otinstaller-release.yml@refs/heads/main`, GitHub OIDC): verified.
4. *`ot` falls back to the mirror.* A local proxy in front of the production API rewrote the manifest's image to
   `ghcr.io/otinstaller/drill-gone@sha256:588a79f1…` (same digest, a repository ghcr refuses). `ot install` printed
   `error from registry: denied`, then "ghcr.io refused the image; pulling the same digest from the OTInstaller
   mirror", verified the signature and installed (`from_backup: true`); `ot run … --url <jpeg>` exited 0 with hashes.

Note for Windows hosts: restoring a bundle into a repository under a long path (such as the Claude scratchpad) fails
with "Filename too long"; use a short path or `git config core.longpaths true`.

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
- [x] Week 11 backups merged and deployed; restore drill run once (21 Oct, below).
- [ ] Build the site with `PUBLIC_BETA=0` to drop the beta strip.
- [x] Remove the dry-run packages. Done 21 Oct about 10:24 UTC in the admin console (Reports → Take down, every
      version, category `other`): `dheerajydv19/ot-test-tool` and `osintversehq/ot-test-tool`. Their pages and API
      reads answer 410, search no longer finds them (`/v1/tools?kind=tool` total 39 → 37), and the Beta tab shows 0
      external publishers (was 2, both test namespaces). They are listed on the public transparency page as two
      `other` removals, and their backups are deleted after 14 days. Their old failed publishes stay in the Beta
      tab's 7-day list until they age out.
- [ ] **(you)** Legal review: hire a lawyer and send them the lawyer brief (`docs/legal/lawyer-brief.md`, not legal
      advice, prepared 21 Oct) with the draft policy fixes. Both are on the local branch `claude/legal-drafts` only,
      kept out of this repository because it is public; open points are marked `[[…]]`. Before or alongside: confirm
      OSINTverse's exact legal name and form, register a DMCA agent, name a grievance officer.
- [ ] Receive mail at otinstaller.com. 21 Oct: Email Routing is enabled (MX records live) and hi@osintverse.com is
      added as the destination. **(you)** Click Cloudflare's verification link in the hi@osintverse.com inbox; then
      create the forwarding rules for support@, privacy@, abuse@, security@, legal@ and dmca@:
      `npx wrangler email routing rules create otinstaller.com --match-type literal --match-field to --match-value support@otinstaller.com --action-type forward --action-value hi@osintverse.com`
      (once per address). Until then mail to them bounces.
- [ ] **(you)** Code signing ([code-signing.md](code-signing.md)): wired into the release workflow and off until set
      up. Windows: Azure Trusted Signing (about $9.99/month; check eligibility) or an OV certificate on a cloud HSM.
      macOS: Apple Developer Program ($99/year) for Developer ID signing and notarization.
- [x] Source public: `OTInstaller/otinstaller` made public 21 Oct (history scanned with gitleaks first: no secrets).
- [x] Site deployed without the beta strip (21 Oct, `a8ff315`); `ot` v0.12.1 released.
- [ ] Dummy repositories out of public view: `dheerajydv19/ot-test-tool` and `dheerajydv19/ot-test-guide` are private
      and archived (21 Oct). **(you)** GitLab `osintversehq/ot-test-tool` is still public: Settings → General →
      Visibility → Private → Save, or Settings → General → Advanced → Delete. To delete the GitHub ones for good:
      `gh repo delete dheerajydv19/ot-test-tool` and `gh repo delete dheerajydv19/ot-test-guide`.
- [ ] Resubmit the sitemap in Google Search Console (crawlers saw 404s and 500s on 21 Oct).
- [ ] On-call rota for launch week; launch posts (plan, week 13). Drafts and templates in [launch/](launch/README.md)
      (21 Oct): rota and reviewer schedule, posts for each channel, demo video script. Nothing posted; each needs your OK.
