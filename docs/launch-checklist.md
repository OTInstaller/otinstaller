# Launch checklist: the public launch

The launch is **public and direct**. The closed beta planned for week 12 never ran: nobody was invited, and on
21 Oct 2026 it was decided to launch publicly instead. The sections further down are kept as the record of the
readiness audit, the production dry run and the beta preparation on 21 Oct; they describe what was true then.
Items marked **(you)** need the owner of the GitHub, GitLab, Cloudflare, Resend, PyPI or osintverse.com accounts.

## Current state (24 October 2026)

| Thing | State |
|-------|-------|
| `ot` | v0.16.0 is the latest release on `OTInstaller/ot` (24 Oct, 12:07 UTC), with the daily update note, holds and `GET /v1/latest`; `/ot/latest` answers `v0.16.0`, and the Windows amd64 archive matches `checksums.txt` and reports `ot version v0.16.0`. Before it, v0.15.0 (23 Oct, 19:49 UTC) |
| API and site | Deployed from `main` (`f6b3ff4`) on 24 Oct at 12:57 and 12:59 UTC with following publishers and input types and the build watcher ("Follows and the build watcher" below): migrations up to 0031 are in production, and `UPSTREAM_WATCH` is `issues`. Earlier that day, deployed from `main` (`2afda1c`) with "Keeping tools up to date" (below): migrations 0028 and 0029 applied, the API at 11:49 UTC and the site with `PUBLIC_BETA=0` at 11:51; migrations up to 0029 are in production. Before that, deployed from `main` (`6787737` and later docs) on 23 Oct: the API at 19:16 UTC, the mirror (now bound to D1) at 19:18 and the site with `PUBLIC_BETA=0` (no beta strip) at 19:44; migrations up to 0027 applied in production ("Phase 1 and publishing" below). The API and site were deployed again at 20:42 and 20:43 UTC with the D1 outage handling ("D1 outages" below); the mirror wasn't, as nothing it runs changed |
| Agents | `ot mcp` (since v0.13.0), the remote MCP server at `https://api.otinstaller.com/mcp`, the plugin `OTInstaller/agent-plugin` v0.1.2 (tag `v0.1.2`, 24 Oct); MCP Registry entries `com.otinstaller/ot` 0.15.0 (the latest there: listing 0.16.0 is left to the owner) and `com.otinstaller/registry` 1.0.0 |
| otlite | 1.3.0 is the latest on PyPI (24 Oct, 12:18 UTC, `release-otlite.yml` with the `otinstaller` shim job passing), with the GitHub release `otlite-v1.3.0`. Before it: 1.0.0, 1.1.0 and 1.2.0 on 22 Oct, and 1.2.1 ([PR #48](https://github.com/OTInstaller/otinstaller/pull/48)) the same evening |
| `otinstaller` shim | 0.2.0 is on PyPI (22 Oct, 11:23 UTC), and its files are on the `otlite-v1.2.0` GitHub release. The workflow publishes it from its own environment `pypi-otinstaller` ([PR #44](https://github.com/OTInstaller/otinstaller/pull/44)), but in the `otlite-v1.2.0` run that job failed with `invalid-publisher` (10:52 UTC), so the Actions history doesn't show how 0.2.0 was uploaded. **(you)** Check that PyPI's trusted publisher for `otinstaller` names the environment `pypi-otinstaller` before the next release |
| otlite installer | `curl -fsSL https://get.otinstaller.com/otlite \| sh` answers 200 (`otlite/scripts/install.sh` from `main`, through `ops/get`) |
| Site pages | `/agents`, the homepage for AI agents, with its Markdown twin `/agents.md`; `/otlite` and `/otlite/tools`, both listing every tool from `web/src/data/otlite-catalog.json`; tool pages show the sample output recorded by the scanner's smoke test |

## Follows and the build watcher (deployed 24 October 2026)

Following publishers and input types ([#107](https://github.com/OTInstaller/otinstaller/pull/107), migration 0030),
and the build watcher: first-party tools' PyPI dependencies and every community-namespace build's base image, plus
`UPSTREAM_WATCH=issues` ([#108](https://github.com/OTInstaller/otinstaller/pull/108), migration 0031). Merged into
`main` (`f6b3ff4`); on that commit `npm test` in `api/` (478) and `web/` (206) passes. D1's Time Travel bookmark
before the migrations is `00000340-00000000-0000510e-1dbf6eb6fcffe0d019c88dab506d128e`.

- [x] Apply the migrations: 0030 and 0031 applied on 24 Oct, 12:56 UTC.
- [x] Deploy the API. Now `61af0e12-a336-4838-8fcd-d14c0d13e387` (12:57 UTC); roll back to
      `3ba5eb38-a472-41ec-8884-9e6e00f6a08b`. Checks: `/v1/health` 200; `PUT /v1/me/follows/input/domain` answers 401
      signed out; `/v1/openapi.json` lists `/me/follows/{kind}/{target}` and the tool detail's `dependencies`;
      `/v1/upstream/summary` says `issues` (6 wrappers behind, 1 error).
- [x] Deploy the site with `PUBLIC_BETA=0`. Now `d7561412-d309-4933-83b1-c9c394630eda` (12:59 UTC); roll back to
      `0196ad22-345c-4d36-a49c-b868d9bffcec`. Checks: `/osintverse-community` shows "Follow publisher" and
      `/input/domain` "Follow new tools", each offering sign-in links when signed out.
- [ ] Check after the nightly run (03:17 UTC on 25 Oct): `dependency_watch` has rows for dns-records, image-hash and
      phone-parse, `base_watch` one per Docker build in `osintverse-community`, and any wrapper behind a release for
      three days has an outdated issue.
- [ ] **(you)** Decide on `REBUILD_WATCH=rebuild` once the community bot is set up and the base image records look
      right: packages whose base image changed and whose scan found fixable critical or high vulnerabilities are then
      rebuilt as a new patch version, at most every two weeks each and five a day.

## Keeping tools up to date (deployed 24 October 2026)

Four pull requests: `ot`'s daily update note, holds and `GET /v1/latest`
([#99](https://github.com/OTInstaller/otinstaller/pull/99)); bump release outcomes and `UPSTREAM_WATCH=auto`
([#100](https://github.com/OTInstaller/otinstaller/pull/100), migration 0028); following a package's releases
([#101](https://github.com/OTInstaller/otinstaller/pull/101), migration 0029); otlite 1.3.0
([#102](https://github.com/OTInstaller/otinstaller/pull/102)). All merged into `main` (`0f71ec0`) on 24 Oct; on that
commit the Go tests, `npm test` in `api/` (462) and `web/` (205), and otlite's 571 tests pass, and
`npx wrangler deploy --dry-run` builds the API. The migrations and deploys ran on 24 Oct once the owner allowed
those exact commands in `.claude/settings.local.json`. D1's Time Travel bookmark before the migrations is
`00000321-00000000-0000510e-e78c8e70e661837cf50f8ac32043c858`.

- [x] Apply the migrations: in `api/`, `npx wrangler d1 migrations apply otinstaller --remote`. 0028 and 0029 applied
      on 24 Oct, 11:48 UTC.
- [x] Deploy the API: in `api/`, `npm run deploy`. Now `3ba5eb38-a472-41ec-8884-9e6e00f6a08b` (24 Oct, 11:49 UTC);
      roll back to `cf3639a6-dc66-4fbd-bf9d-925180288eb8`. Checks: `/v1/health` 200; `/v1/latest` lists 113 packages,
      `public, max-age=3600`; `/v1/tools/osintverse-community/sherlock/follow` answers 401 signed out;
      `/v1/upstream/summary` says `report`.
- [x] Deploy the site with `PUBLIC_BETA=0`: in `web/`, `PUBLIC_BETA=0 npm run deploy`. Now
      `a59d86c6-1660-41a8-b4e7-16e9f4fe4870` (24 Oct, 11:51 UTC); roll back to `d8c4a74f-7dfa-4c23-a1e7-6be77c66c024`.
      Checks: `/docs/updates` and its `.md` twin load; `/docs/errors` has `version_held`, `bump_in_progress` and
      `release_workflow_failed`; the sherlock page shows "Follow releases", which offers sign-in links when signed out;
      `/settings/notifications` asks to sign in; the privacy policy has the daily check; no beta strip and no CSP
      errors in the browser.
- [x] Release `ot` 0.16.0: tag `v0.16.0` pushed, released on `OTInstaller/ot` on 24 Oct at 12:07 UTC. The agent
      plugin 0.1.2 is pushed to `OTInstaller/agent-plugin` with the tag `v0.1.2`.
- [ ] **(you)** List `ot` 0.16.0 in the MCP Registry (publishing it was refused to the agent): in a folder holding the
      release's `server.json`, `mcp-publisher login http --domain otinstaller.com --private-key "$(cat
      ~/.mcp-registry/otinstaller.com.ed25519.hex)"`, then `mcp-publisher publish server.json`.
- [x] Release otlite 1.3.0: `debian/changelog` has 1.3.0-1 ([#105](https://github.com/OTInstaller/otinstaller/pull/105)),
      and the tag `otlite-v1.3.0` released it to PyPI on 24 Oct at 12:18 UTC.

## D1 outages answered with 503 (deployed 23 October 2026)

Sentry's OTINSTALLER-A and -B were twelve `D1_ERROR: internal error; reference = ...` events from 21 to 23 Oct, on
read-only queries D1 had already retried. The API now answers such failures with 503 `database_unavailable` and
`Retry-After`, reports them as one grouped Sentry warning per kind, and the site retries a read once
([troubleshooting.md](dev/troubleshooting.md#d1-read-limit-exhaustion)). It was deployed from the branch
`claude/d1-transient-errors` before that was merged.

- [x] Deploy the API: in `api/`, `npm run deploy`. Now `cf3639a6-dc66-4fbd-bf9d-925180288eb8` (23 Oct, 20:42 UTC);
      roll back to `3c1b95bd-a431-4f15-9d0a-455c2100d6ec`.
- [x] Deploy the site with `PUBLIC_BETA=0`: in `web/`, PowerShell `$env:PUBLIC_BETA = "0"; npm run deploy`. Now
      `d8c4a74f-7dfa-4c23-a1e7-6be77c66c024` (23 Oct, 20:43 UTC); roll back to `d2d15efe-7c5d-4a35-9b90-aa558d9c4087`.
      Checks: `/v1/tools` and `/v1/health` answer 200, the site has no beta strip, and `/docs/errors` has
      `database_unavailable`.
- [x] Merge the pull request for `claude/d1-transient-errors`, so a deploy from `main` keeps the handling. Done 23 Oct,
      20:52 UTC: [#97](https://github.com/OTInstaller/otinstaller/pull/97), merged as `ccc59c1`.
- [x] Resolve OTINSTALLER-A and -B in Sentry: new D1 failures arrive as warnings under the fingerprint
      `d1-unavailable`. OTINSTALLER-6 (an old `otinstaller` 0.1.0 usage error otlite no longer reports), -8 (the setup
      test) and -9 (the 21 Oct read-limit outage, fixed by the edge cache and Workers Paid) went too. Done 23 Oct
      after the merge, each with a comment saying why; the project has no unresolved issues.

## Phase 1 and publishing (merged and deployed 23 October 2026)

The roadmap's phase 1 ([roadmap.md](roadmap.md)) was merged into `main` on 23 Oct: #58 (roadmap, stars), #61 (release
notes), #63 (activity and feeds), #66 (learn hub), the community stack #68 → #74 → #76 → #78 → #79 → #80 → #81 → #82 →
#83 and the close-out #84. Request discussions and flags on requests followed in
[#89](https://github.com/OTInstaller/otinstaller/pull/89) (migration 0026), and change proposals with a new version's
first-week counts in [#90](https://github.com/OTInstaller/otinstaller/pull/90) (migration 0027, merged as
`6787737`). Publishing without a tag merged the same day: the OAuth callback fix
[#85](https://github.com/OTInstaller/otinstaller/pull/85), direct publishing with `ot publish`
[#86](https://github.com/OTInstaller/otinstaller/pull/86) (0023), images hosted on the mirror
[#87](https://github.com/OTInstaller/otinstaller/pull/87) (0024) and trusted publishing from CI
[#88](https://github.com/OTInstaller/otinstaller/pull/88) (0025). All of it was deployed on 23 Oct; what's left is
marked (you). In order:

- [x] Copy the scanner to registry-ops before the API sends direct uploads. Done 23 Oct: `OTInstaller/registry-ops`
      `068fc51` (`scan.py` accepts `expected_signer: null` and records the smoke test's sample; `scan.yml` logs Docker
      in to the mirror too).
- [x] Expire abandoned uploads: lifecycle rule `expire-uploads` on the R2 bucket `otinstaller-content`, prefix
      `uploads/`, objects expire after 7 days. Done 23 Oct.
- [ ] **(you)** Review the terms change from #87 (`web/src/pages/policy/terms.md`: images hosted on the mirror, and
      namespaces created on the registry); it went live with the site deploy on 23 Oct, 19:44 UTC.
      [#94](https://github.com/OTInstaller/otinstaller/pull/94) suggests wording for two gaps: publishers' licence to
      the registry covers backup copies but not hosting and serving images pushed to the mirror, and the terms don't
      say idle registry namespaces are deleted after 30 days. Merge it and deploy the site, or close it.
- [x] Apply migrations 0015 to 0027 remotely: in `api/`, `npx wrangler d1 migrations apply otinstaller
      --remote` (13 migrations; the permission classifier refuses this to the coding agent as a production deploy).
      The bookmark before them is `0000021a-00000008-0000510d-148af29bf74db2c6a521a2eea887be46`; restore with
      `npx wrangler d1 time-travel restore otinstaller --bookmark=<that>`. Done 23 Oct by the owner, from the
      repository root with `--config api/wrangler.jsonc`; `d1 migrations list --remote` shows none left.
- [x] Deploy, after the migrations (done 23 Oct by the owner):
      1. The API: in `api/`, `npm run deploy`. Now `3c1b95bd-a431-4f15-9d0a-455c2100d6ec` (19:16 UTC); roll back to
         `1e5d3dac-1465-428c-bb46-45770d5e7e22`.
      2. The mirror, which now binds the D1 database: in `api/`, `npx wrangler deploy -c wrangler.mirror.jsonc`. Now
         `598a53cc-d9f5-467f-a2b9-9e3ab696fc18` (19:18 UTC); roll back to `b222af4e-ee1a-47b2-89d8-a411b338ec02`.
      3. The site with `PUBLIC_BETA=0`: in `web/`, PowerShell `$env:PUBLIC_BETA = "0"; npm run deploy`. Now
         `d2d15efe-7c5d-4a35-9b90-aa558d9c4087` (19:44 UTC); roll back to `1326b475-6249-4a94-9355-adc015f9d642`.
      Checks: `https://api.otinstaller.com/v1/openapi.json` lists `/publish` and `/auth/oidc/token`;
      `curl -sI https://mirror.otinstaller.com/v2/` answers 401 with a `Bearer` challenge; `/publish` on the site
      shows three ways in and no beta strip. All three checked after the deploy, plus `POST /v1/publish` without a
      token (401 `unauthenticated`) and `POST /v1/auth/oidc/token` with a junk token (401 `oidc_token_invalid`).
- [ ] **(you)** Grant the first triager and reviewer roles (Admin console → Community).
- [ ] **(you)** Set up the community bot for submissions, bump pull requests and change proposals (publishing-setup.md section 6,
      "Community submissions"): the "OTInstaller Community" GitHub App and its three secrets. The main App is already
      installed on all repositories of `osintverse-community` (checked 24 Oct). Until then submitting answers 503 and
      the rest works.
- [x] Set `UPSTREAM_WATCH` to `issues`: done in `wrangler.jsonc` and deployed on 24 Oct. **(you)** Once the community
      bot is set up, decide whether to move it to `prs`.
- [ ] **(you)** Once bump pull requests have released cleanly for a while under `prs` (Admin console → Upstream,
      "Latest bump"), decide whether to set `UPSTREAM_WATCH` to `auto`: pin-only bumps of stable releases then go out
      on their own a week after upstream's release, at most ten a day, unless a package's maintainers turn it off.
      Setting `prs` again stops it.
- [x] Apply migration 0029 (following packages' releases) and deploy the site for the "Follow releases" button: done
      24 Oct.
- [x] Release `ot` v0.15.0 once the API above is live (its new commands need it): `ot publish` (with `--image`,
      `--sign` and `--oidc`), `ot namespace create|trust|trusted|untrust`, `ot issues`, `ot request`, `ot changelog`,
      `ot report --works|--broken`, the failure prompt and the first-week note in `ot outdated`. Push the tag `v0.15.0`
      on `main`. It must be out before anyone sets `OTINSTALLER_PUBLISH=oidc`, because the release workflows' last step
      installs the latest `ot`. Done 23 Oct, 19:49 UTC: tag `v0.15.0` on `7808e0d`, release
      run `40014068906`.
- [x] List `ot` 0.15.0 in the MCP Registry. Done 23 Oct, 19:55 UTC: `com.otinstaller/ot` 0.15.0 is the latest entry
      (checked 24 Oct at `https://registry.modelcontextprotocol.io/v0/servers?search=com.otinstaller`).
- [x] Publish the draft guide `seed/guides/osint-fundamentals/`. Done 23 Oct: the public repository
      `osintverse-community/osint-fundamentals` (created 20:01 UTC, one commit `318f802`, annotated tag `v1.0.0`);
      the registry published `osintverse-community/osint-fundamentals` 1.0.0 at 20:03 UTC and set the tag's
      `otinstaller/publish` status to success.

## Left before announcing

- [ ] **(you)** Legal review (details under "Before the public launch" below).
- [ ] **(you)** Code signing for Windows and macOS ([code-signing.md](code-signing.md)).
- [ ] **(you)** Delete the GitHub test repositories `dheerajydv19/ot-test-tool` and `dheerajydv19/ot-test-guide`
      (private and archived now), and make GitLab `osintversehq/ot-test-tool` private or delete it.
- [ ] **(you)** Resubmit the sitemap in Google Search Console.
- [ ] **(you)** Submit the plugin to Anthropic's directory and the Cursor marketplace (texts in
      [launch/agent-listings.md](launch/agent-listings.md)); try `ot mcp` and the plugin in a real client first.
- [x] Deploy `ops/get` so `get.otinstaller.com/ot/latest` answers `{"version"}`. Done 23 Oct from `main` (`0afa4b2`,
      `npx wrangler deploy --config ops/get/wrangler.jsonc` from the repository root, version
      `d2d55f10-9903-4a21-bb7d-8b7b9c0ed93b`); `/ot/latest` answers `{"version":"v0.14.0"}` with
      `cache-control: public, max-age=3600`.
- [x] List `ot` 0.14.0 in the MCP Registry. Done 23 Oct: the release's `server.json` published with `mcp-publisher`
      v1.8.1 (`go install github.com/modelcontextprotocol/registry/cmd/publisher@v1.8.1` builds it as `publisher.exe`
      in `~/go/bin`, which isn't on the PATH) after `login http --domain otinstaller.com --private-key <hex>`.
- [x] Release `ot` v0.14.0 (`ot install a b c`, three more bundled playbooks, the fresh-machine offer, `ot runs`,
      lifecycle flags in `ot outdated` and `ot update` following moved packages, the newer-`ot` note), then publish
      the agent plugin 0.1.1, whose skill names the new playbooks and `run_all`'s `not_installed`. Done 23 Oct: v0.14.0
      on `OTInstaller/ot`, and `OTInstaller/agent-plugin` v0.1.1 (commit "Release 0.1.1", tag `v0.1.1`).
- [ ] **(you)** Pick the launch date and approve the launch posts ([launch/](launch/README.md)); nothing is posted.
- [ ] **(you)** Back up `~/.mcp-registry/otinstaller.com.ed25519.hex` somewhere safe and offline. Without it, a new
      key pair, a new `web/public/.well-known/mcp-registry-auth` and a site deploy are needed to publish to the MCP
      Registry again.
- [x] Re-release the seed packages whose manifests gained `ethics.notifies_target`/`notes` or a key's `pricing`. Done
      22 Oct: dnsrecon 1.6.4, httpx 1.12.1, tlsx 1.4.1, holehe 1.61.1, shodan-host 1.31.1, exif-meta 0.1.1 and
      image-hash 0.1.1 are published and `@latest`, with the new fields in `manifest_full`. fierce and finalrecon were
      never published, so there was nothing to re-release
      ([../seed/README.md](../seed/README.md), "notifies_target and key pricing").

## History: blocking the beta (21 October 2026)

These would have stopped testers on day one. **All done as of 21 Oct.** The beta itself never ran.

| # | Item | State | What it needs |
|---|------|-------|---------------|
| 1 | **`ot` has never been released.** No `OTInstaller/ot` release repository, no tags, no Homebrew tap or Scoop bucket, and `get.otinstaller.com` doesn't resolve, so every install command in the docs fails. | Release workflow and GoReleaser config exist. `ops/get/` (new) serves the install scripts at get.otinstaller.com. The install scripts are tested end to end on Windows here and in a Linux container; `.github/workflows/cli-install.yml` (new) covers Linux, macOS and Windows on CI. **Done (21 Oct):** `ot` v0.12.0 is the latest release on `OTInstaller/ot`; `get.otinstaller.com` is deployed. Verified against the published release: `irm https://get.otinstaller.com/ot.ps1 \| iex` on Windows 11 and `curl -fsSL https://get.otinstaller.com/ot \| sh` in a Debian container both install with "Signature verified"; `ot --version`, `ot self-update` ("v0.12.0 is the latest release") and `ot search` against production work on both. | Nothing for the beta. Later: Homebrew tap and Scoop bucket (`TAP_GITHUB_TOKEN`); the install docs hide them until then. |
| 2 | **Email doesn't send.** Resend answers `401 API key is invalid`; 79 notifications had failed since 20 Oct when this was audited (publish, reject, review, archive), one was ever sent. Authors get no "published" or "rejected" mail and reviewers no alerts. | Code is fine; the old key had been deleted in Resend. **Done (21 Oct):** `otinstaller.com` is verified in Resend (no DNS changes needed); new key `otinstaller-api` (sending access, otinstaller.com only) set with `wrangler secret put RESEND_API_KEY`. New admin endpoint `POST /v1/admin/email-test` (mails the calling admin, answers with Resend's error on failure) deployed; its test email showed "Delivered" in Resend. | Nothing. The 81 notifications that failed on 20–21 Oct are **not** re-sent (decided 21 Oct: stale). |
| 3 | **Testers can't file issues.** `OTInstaller/otinstaller` is private, so the bug-report link on the site and in `ot feedback` 404s for anyone outside the org, and the admin console can't count sev-1 issues. | Issue forms with a severity field, a labeller workflow and `scripts/beta/labels.sh` are on this branch. **Done (21 Oct):** public `OTInstaller/feedback` has the issue forms, `issue-severity.yml` and the beta labels (`sev-1`–`sev-3`, `beta`, `needs-triage`, `area:*`). The API and site default to it (`60ea168`, deployed), so no `ISSUES_REPO`/`PUBLIC_ISSUES_URL` override is needed. Verified: production `/feedback` links to `github.com/OTInstaller/feedback/issues`; `ot feedback` without a message opens that page. | Nothing. |
| 4 | **GitLab publishing was impossible.** Found in the dry run: (a) the GitLab OAuth app lacked the `api` scope, so connecting a project failed at GitLab; (b) all three GitLab release templates were invalid YAML; (c) they needed a project access token, which is paid-only on GitLab.com; (d) new GitLab.com projects can't set pipeline variables, so "run a pipeline with VERSION" didn't work; (e) arm64 images couldn't build without QEMU; (f) the registry set GitLab's commit status to `running` twice and GitLab's 400 failed the job, rejecting every GitLab release. | (a) fixed on the app (21 Oct) and in the setup guide; (b)–(f) fixed on this branch (`165961e`, `0df6d53`, `d9a19a0`) and **deployed** (`d9a19a0`, 21 Oct). **Done (21 Oct):** the GitLab application is now "OTInstaller" with only `https://api.otinstaller.com/v1/auth/gitlab/callback`. Verified: web sign-in with GitLab reaches the dashboard, and `ot login --gitlab` (device grant, consent screen says "OTInstaller") signs in. | Nothing. Local development needs its own GitLab app now (the 127.0.0.1 callback is gone). |
| 5 | **Production was down** most of 21 Oct: crawlers walking every search filter combination used up D1's free daily reads, and every page answered 500 or 404. | Fixed and deployed (`2821b22`, `1bd47e4`): edge cache for anonymous API reads, nofollow and noindex on filtered views, `Disallow: /*?`, a 500 page. You moved the account to Workers Paid. | Nothing. Watch D1 reads in the Cloudflare dashboard for a few days. |

## History: merges and deploys (21 October 2026)

| Item | State | What it needs |
|------|-------|---------------|
| This branch (`claude/week12-beta-7d9771`) | Production runs `90b9c2c`: main (weeks 1–11, PR #3, PR #4) plus all of week 12; migrations up to 0012 applied. Only docs were committed after it. **Done:** merged as [PR #5](https://github.com/OTInstaller/otinstaller/pull/5) (21 Oct, `ot install` matrix green), followed by PRs #6–#12; main's `ot install` workflow is green. Week 11's resources exist (checked 21 Oct): R2 buckets `otinstaller-backups` and `otinstaller-mirror`, the `otinstaller-mirror` Worker (mirror.otinstaller.com answers `/v2/` with 401 as expected) with `MIRROR_PUSH_TOKEN`, the `R2_*` secrets on the API, and migrations 0011 and 0012 applied remotely. | Nothing. |
| Week 11 backups ([PR #3](https://github.com/OTInstaller/otinstaller/pull/3), merged into main 21 Oct) | **Live** (checked 21 Oct, see "Backups and restore drill" below): both R2 buckets, the R2 token secrets and `MIRROR_PUSH_TOKEN` on the API, the mirror Worker at mirror.otinstaller.com, migration 0011 applied remotely, and `backup.py`, `scan.py` and `scan.yml` in registry-ops identical to this repo. | Nothing. |
| PR #2 (Python package manager merge) | Merged into main on 20 Oct (`6b8f6a6`). Deployed with this branch. | Nothing. |
| Site docs that went live "at the next deploy" | Live since today's deploy. | Nothing. |
| API `total` on `/v1/tools` and `/v1/guides` | Live (`/v1/tools?kind=tool` total 38, `/v1/guides` total 10). | Nothing. |

## Every otlite tool on /otlite (23 October 2026)

[PR #54](https://github.com/OTInstaller/otinstaller/pull/54), merged as `52f5b97`, is live. `/otlite` lists every tool
otlite installs, with the filter buttons from `/otlite/tools` (both pages now share `components/OtliteCatalog.astro`),
and computes its counts from the catalog instead of hard-coding them.

| Step | Result |
|------|--------|
| Site | Deployed from `main` (`52f5b97`) with `PUBLIC_BETA=0` as version `293e9aa9-7a73-470f-bc0b-ed99318692ae`. Roll back to `7c4ed6de-df20-483e-88a7-706e0a79ce54`. The first deploy of this commit, `cb77262c-1a93-496e-a167-d5851902da4f`, was built without `PUBLIC_BETA=0` and showed the beta strip for about 80 seconds (07:08:57 to 07:10:17 UTC) before `293e9aa9` replaced it. |
| API | Not deployed; nothing changed there. |
| Checks | `/`, `/otlite`, `/otlite/tools` and `/agents` answer 200 with no beta strip. `/otlite` and `/otlite/tools` each list 47 tools, and `/otlite` shows the same counts by input type as before (24 username, 19 domain, 14 email, 11 URL, 7 IP, 5 name, 4 phone). In the production preview the filter buttons work under the CSP and both pages fit a 375px phone. |
| Still to do | Nothing. |

## Homepage for AI agents (23 October 2026)

[PR #52](https://github.com/OTInstaller/otinstaller/pull/52), merged as `95af735`, is live. `/agents` brings together
connecting an AI client to `ot mcp` or the remote MCP server, what an agent can do, consent, and the entry points for
programs; `/agents.md` is its Markdown twin, written for agents. The same PR put otlite and Agents in the top nav and
stopped the home page scrolling sideways on phones.

| Step | Result |
|------|--------|
| Site | Deployed from `main` (`95af735`) with `PUBLIC_BETA=0` as version `7c4ed6de-df20-483e-88a7-706e0a79ce54`. Roll back to `18f73b89-250e-4c7a-a8e3-0d94df16d821`. |
| API | Not deployed; nothing changed there. |
| Checks | `/`, `/agents`, `/tour`, `/otlite`, `/otlite/tools`, `/osintverse-community` and `/docs/agents` answer 200. `/agents.md`, and `Accept: text/markdown` on `/agents` (private, with `Vary: Accept`), return the Markdown; `/osintverse-community.md` still works. `llms.txt`, `robots.txt` and the sitemap name `/agents`. No beta strip, no console errors on `/agents`, and `/` and `/agents` fit a 375px phone. |
| Still to do | Nothing for the page. The agent plugin's manifests and the `.mcpb` bundles still link to `/docs/agents`; pointing them at `/agents` needs new releases of both. |

## Publisher profiles (22 October 2026)

[PR #49](https://github.com/OTInstaller/otinstaller/pull/49), merged as `6a2890b`, is live: every namespace has a profile
at `otinstaller.com/<namespace>`, synced from GitHub or GitLab, with an owner Profile tab and `ot profile`.

| Step | Result |
|------|--------|
| Migration 0014 | Applied remotely; it was the only pending migration. |
| API | Deployed from `main` as version `1e5d3dac-1465-428c-bb46-45770d5e7e22`. Roll back to `fe8ed60f-de32-4ae8-8e30-fc785cc9c155`. |
| Site | Deployed from `main` with `PUBLIC_BETA=0` as version `eb560212-62ad-4a05-8271-908693a79e04`. Roll back to `d8409e6c-6293-45be-896a-141f247f5d37`. |
| Checks | `/v1/health` OK. `/v1/namespaces/osintverse-community` returns the profile and stats (112 packages). `/v1/namespaces` and `/activity` answer 200. The profile page renders in both themes with no CSP errors; the Markdown twin and the llms.txt publisher list are live. A tool page and search still work. The first profile sync ran from the cron (GitHub avatar and creation date present). |
| Still to do **(you)** | GitHub App: add the Organization permission Members: Read-only and subscribe to the Organization and Membership events (`docs/publishing-setup.md`). Until then org profiles refresh only every 6 hours and on Sync now. |

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

Superseded on 21 Oct 2026: nobody was invited to the closed beta, and the launch is public and direct. Kept for the
record.

- **No invite gate.** Every new namespace already waits in the review queue for a reviewer, so only approved
  people can publish. Approve the invited authors' namespaces; reject others politely until launch.
- **Feedback** goes to D1 (`/admin/feedback`); bugs that block someone also go to GitHub issues with a severity,
  which the Beta tab counts.

## Before the public launch (week 13), as tracked from 21 Oct

- [x] ~~Beta exit criteria met, survey read~~: doesn't apply. There was no beta cohort; the launch is public (21 Oct).
- [x] Week 11 backups merged and deployed; restore drill run once (21 Oct, below).
- [x] Build the site with `PUBLIC_BETA=0` to drop the beta strip. Every deploy since 21 Oct has (latest `c4e822b4`).
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
- [x] Receive mail at otinstaller.com (21 Oct). Cloudflare Email Routing is on (MX records `route1–3.mx.cloudflare.net`),
      and support@, privacy@, abuse@, security@, legal@ and dmca@otinstaller.com forward to hi@osintverse.com
      (verified destination). Other addresses at the domain are dropped (catch-all off). Tested: a message from an
      ordinary mailbox to support@ arrived at hi@osintverse.com. Cloudflare only forwards mail that passes SPF or
      DKIM, so a message sent straight from a script is refused with `550 5.7.26`; normal mail services pass. To add
      an address: `npx wrangler email routing rules create otinstaller.com --match-type literal --match-field to
      --match-value <name>@otinstaller.com --action-type forward --action-value hi@osintverse.com`.
- [ ] **(you)** Code signing ([code-signing.md](code-signing.md)): wired into the release workflow and off until set
      up. Windows: Azure Trusted Signing (about $9.99/month; check eligibility) or an OV certificate on a cloud HSM.
      macOS: Apple Developer Program ($99/year) for Developer ID signing and notarization.
- [x] Source public: `OTInstaller/otinstaller` made public 21 Oct (history scanned with gitleaks first: no secrets).
- [x] Site deployed without the beta strip (21 Oct, `a8ff315`); `ot` v0.12.1 released.
- [ ] **(you)** Dummy repositories out of public view: `dheerajydv19/ot-test-tool` and `dheerajydv19/ot-test-guide` are private
      and archived (21 Oct). GitLab `osintversehq/ot-test-tool` is still public: Settings → General →
      Visibility → Private → Save, or Settings → General → Advanced → Delete. To delete the GitHub ones for good:
      `gh repo delete dheerajydv19/ot-test-tool` and `gh repo delete dheerajydv19/ot-test-guide`.
- [x] **Agents** ([agent-friendly-plan.md](agent-friendly-plan.md), phases 1–5 merged in
      [PR #18](https://github.com/OTInstaller/otinstaller/pull/18) and [PR #20](https://github.com/OTInstaller/otinstaller/pull/20),
      **deployed 21 Oct**). Decided 21 Oct:
      - **Consent from launch:** `ot run`, `--all`, playbooks and `auto` without a terminal need `--yes` for tools
        that aren't passive. The release notes say: add `--yes`, or set `OT_CONSENT=off`. There was no beta cohort to
        email; the launch is public.
      - **Version:** the release is `ot` v0.13.0 (the manifest docs already say so).
      - **Two stages.** Stage 1 is invisible to users, because the API stays compatible with `ot` v0.12:
        1. **(you)** Apply migration 0013 to production. It must come before the API deploy: the new API reads
           `api_tokens.scoped` on every request that carries a token. In `api/`: `npx wrangler d1 migrations list
           otinstaller --remote` (only 0013 should be pending), then `npx wrangler d1 migrations apply otinstaller
           --remote`.
        2. Deploy the API from `main` (`npx wrangler deploy` in `api/`). Then check `/v1/health`, a search,
           `/v1/openapi.json`, an `ETag` on a read, `POST /mcp` `tools/list`, and that `ot` v0.12.1 still installs a tool.
      - **Stage 1 done 21 Oct.** Migration 0013 was applied at about 16:20 UTC, and the API was deployed from `main` as
        version `f3d0d90b` (previous `9a497a34`, for `wrangler rollback`). The checks passed:
        - `/v1/health`, search, `passive_only` (6 tools, all passive) and `/v1/pivots`
        - `/v1/openapi.json` (3.1.0, 59 paths)
        - ETags with `304` on fresh responses
        - `/mcp` `tools/list` and `get_tool`
        - a bad token answers 401, not 500
        - `ot` v0.12.1 `info`, `search` and `install` read the new API (the install stopped only because Docker
          wasn't running)

        `/v1/types` is still the copy cached before the deploy (`max-age=86400`, no `ETag` and no pivot map) until
        about 10:00 UTC on 22 Oct.
      - **Stage 2 done 21 Oct.**
        - `ot` v0.13.0 was tagged on `97b67b8` and released on `OTInstaller/ot` with the archives, `.deb` and
          `.rpm`, signed checksums, six `.mcpb` bundles and `server.json`.
        - The release notes open with what's new and the `--yes` breaking change, above GoReleaser's commit list.
        - `get.otinstaller.com` serves the install scripts, which take the latest release (not run from here).
        - PR #19 (redesign phase 1, which was already live as `88b96ef6` from its branch) was merged, and the site
          was deployed from `main` `661fa7d` with `PUBLIC_BETA=0` as version `72849570`.
        - Checked: every page answers 200, with no beta strip; the redesign is live; `/docs/agents` (with the remote
          server), `/docs/mcp-tools`, `llms.txt` and the `.md` versions are live; there are no CSP errors in the
          browser. The only console error is the expected signed-out 401 from `/v1/me`.
      - **Rate-limit rule:** in place (you, 21 Oct). The settings it was created from: In the Cloudflare dashboard, open the otinstaller.com zone, then
        Security → WAF → Rate limiting rules → Create rule:
        - Name: `API reads and MCP`.
        - Expression: `(http.host eq "api.otinstaller.com" and (http.request.uri.path eq "/mcp" or
          starts_with(http.request.uri.path, "/v1/tools") or starts_with(http.request.uri.path, "/v1/guides") or
          http.request.uri.path eq "/v1/pivots"))`. If your plan's editor has no "starts with", use "contains".
        - Counting characteristic: IP.
        - Rate: 30 requests per 10 seconds.
        - Action: Block for 10 seconds.

        This keeps D1 reads in check if someone scripts `/mcp` or the search filters. If one rule isn't enough, a
        Workers rate-limiting binding in `/mcp` can follow.
      - **Plugin:** [OTInstaller/agent-plugin](https://github.com/OTInstaller/agent-plugin) is public with v0.1.0
        (21 Oct), and `/docs/agents` gives its install commands and the one-click `.mcpb` download for Claude Desktop.
      - **MCP Registry (21 Oct):** `com.otinstaller/ot` 0.13.0 (the six `.mcpb` bundles) and `com.otinstaller/registry`
        1.0.0 (`https://api.otinstaller.com/mcp`) are listed and active. The domain is proven by the public key at
        `https://otinstaller.com/.well-known/mcp-registry-auth`; the private key is in the owner's `~/.mcp-registry/`.
        The v0.13.0 entry was published with a shortened description (the registry allows 100 characters); releases
        from now on write a short one. Each future release needs `mcp-publisher publish` with its `server.json`
        ([publishing-setup.md](publishing-setup.md) section 10).
      - **v0.13.1 (22 Oct):** `ot keys setup` and the `key_setup` MCP tool (agents help with keys, only the person stores
        them), entities from text and CSV output, type descriptions, and the clearer consent-token error.
        - Tagged on `154adbe` and released with its bundles. `ot self-update` from v0.13.0 worked.
        - Published to the MCP Registry as `com.otinstaller/ot` 0.13.1, now the latest there.
        - API deployed as `121009a6` (previous `05642714`): `/v1/types` has descriptions, but the plain URL serves a
          copy cached before the deploy until about 16:00 UTC on 22 Oct.
        - Site deployed as `414cfa50` (previous `d417effa`), including other sessions' merged work. Every page answers
          200, the new docs are live, and there are no CSP errors.
        - The seed tools' `notifies_target` changes need new releases from their own repositories
          ([../seed/README.md](../seed/README.md)).
      - **Next** (moved to "Left before announcing" above): the Anthropic directory and Cursor marketplace
        submissions (each needs your OK; texts in [launch/agent-listings.md](launch/agent-listings.md)), after a test
        in a real client.
- [ ] **(you)** Resubmit the sitemap in Google Search Console (crawlers saw 404s and 500s on 21 Oct).
- [ ] **(you)** On-call rota for launch week; launch posts and the launch date (plan, week 13). Drafts and templates in [launch/](launch/README.md)
      (21 Oct): rota and reviewer schedule, posts for each channel, demo video script. Nothing posted; each needs your OK.
- [x] otlite on PyPI: 1.0.0, 1.1.0 and 1.2.0 (22 Oct) with GitHub releases; the `otinstaller` shim 0.2.0; the one-line
      installer at `get.otinstaller.com/otlite`; the `/otlite` and `/otlite/tools` pages on the site.
- [x] Seed re-releases for `notifies_target` and key `pricing`: seven published 22 Oct, see "Left before announcing".
