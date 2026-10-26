# Architecture and request flows

Traced through the code in October 2026. Paths are relative to the repository root. `file:function` names are real
symbols; where a step is a route handler rather than a named function, the route is given
(`routes/review.ts POST /internal/scans`). Debugging recipes are in [troubleshooting.md](troubleshooting.md); the
problems found while tracing are listed under "Known gaps and tech debt" in [AGENTS.md](../../AGENTS.md).

Contents

1. System overview
2. Flows
   - a. Publish a tool
   - a2. Publish directly (`ot publish`)
   - a3. Trusted publishing from CI
   - b. Scan
   - c. Guide publish
   - d. Backups
   - e. Install and run in `ot`
   - f. Sign-in
   - g. Review
   - h. Takedown, removal, yank and deprecate
   - i. Anonymous reads: edge cache and site SSR
   - j. `ot self-update` and the install scripts
   - k. Agents: `ot mcp`, unattended runs and the remote MCP server

## 1. System overview

```
   USERS                                     PUBLISHERS
 +---------+  HTTPS /v1 (Bearer ot_...)    +--------------------+   tag push, push, release
 | ot CLI  |---------------------------+   |  GitHub repos      |---- App webhooks -----------+
 | (Go)    |                           |   |  GitLab projects   |---- per-project hook -----+ |
 +---------+                           |   +--------------------+                           | |
   |  |  docker/podman pull by digest  |       ^ commit statuses (otinstaller/publish)      | |
   |  |  cosign verify                 |       | file reads, tags, metadata (App / OAuth)   | |
   |  v                                v       |                                            v v
   | +-----------+  fallback   +-----------------------------------------------------------------+
   | | GHCR,     |  pull       |  otinstaller-registry-api Worker (api.otinstaller.com, Hono)    |
   | | GitLab    |             |   edgeCached() -> app (/v1)     queue consumer: handleBatch()   |
   | | registry, |             |   scheduled(): */15, nightly, weekly Mon, monthly 1st           |
   | | PyPI      |             +--+--------+---------+---------+-----------+--------+---------+--+
   | +-----------+                |        |         |         |           |        |         |
   |      ^ artifact checks       v        v         v         v           v        v         v
   |      +--------------------- D1     R2 CONTENT R2 BACKUPS R2 MIRROR  Queue   Resend    Sentry
   |       (hosts/artifacts.ts) "otin-  (pages,   (git/,     (shared)  otinst- (email)   (errors)
   |                            staller" images)   wheels/)     |      aller-
   |                                                 ^          |      publish
   +--- docker pull mirror.otinstaller.com/... ---+  | signed   |
                                                  |  | PUT URLs |
 +---------+  credentialed CORS (ot_session)      |  |          v
 | website |-------------------> API Worker       | +-------------------------------+
 | Astro   |  SSR: anonymous fetch -> edge cache  +-| otinstaller-mirror Worker     |
 | SSR     |                                        | (OCI registry on R2 MIRROR)   |
 +---------+                                        +-------------------------------+
                                                           ^ crane copy (push token)
   API --- repository_dispatch (otinstaller-scan | -backup | -drill) ---+   |
                                                                       v   |
                                     +-----------------------------------------------+
                                     | OTInstaller/registry-ops (GitHub Actions)     |
                                     |  scan.yml: scan.py (cosign, Trivy, GuardDog,  |
                                     |            smoke test), backup.py, drills     |
                                     +-----------------------------------------------+
                                       | POST /v1/internal/scans, /internal/backups/:run,
                                       | /internal/drills/:id  ---> API

 Sign-in: API /v1/auth/:provider/... <-> github.com OAuth, gitlab.com OAuth, osintverse.com OIDC
 Install: curl get.otinstaller.com/ot | sh -> otinstaller-get Worker (ops/get/worker.js)
          -> github.com/OTInstaller/ot/releases/latest/download/install.sh (cached 300 s)
          -> script fetches ot_<ver>_<os>_<arch> + checksums.txt(.sig) from OTInstaller/ot releases
 Self-update: ot -> get.otinstaller.com/ot/latest -> assets from github.com/<Repo>/releases/download/<tag>/
              (fallback: api.github.com/repos/otinstaller/ot/releases/latest); ot outdated: the same lookup, daily
```

Bindings (`api/wrangler.jsonc`): D1 `DB` (`otinstaller`), R2 `CONTENT`, `BACKUPS`, `MIRROR`, queue `PUBLISH_QUEUE`
(`otinstaller-publish`, consumer `max_batch_size: 5`, `max_retries: 5`, `retry_delay: 30`). Crons:
`17 3 * * *`, `*/15 * * * *`, `41 4 * * 1` (`WEEKLY_BACKUP_CRON`), `23 5 1 * *` (`RESTORE_DRILL_CRON`).
All outbound HTTP from the API goes through `deps.fetch` (`api/src/env.ts`).

What each cron does (`api/src/index.ts` `scheduled`), in order:

| When | Calls |
| --- | --- |
| Every 15 min (all four crons run this part) | `scans.ts:expireStaleScans`, `sync.ts:pollDueSources` (50 sources not polled for 6 h), `ops.ts:alertStuckJobs`, `backups.ts:expireRuns`, `backups.ts:expireDrills`, `backups.ts:backfillBackups` (5 versions), `indexnow.ts:flushIndexNow` |
| Mondays 04:41 UTC | + `backups.ts:weeklyBackups` |
| 1st of month 05:23 UTC | + `backups.ts:startDrill` |
| Nightly 03:17 UTC | + `guides.ts:queueNightlyLinkChecks`, `ops.ts:dailyDigest`, `ops.ts:purgeRateLimits`, `backups.ts:purgeBackups`, `community.ts:refreshAllHealth`, `installs_30d` recompute (SQL inline) |

Queue messages (`PublishMessage` in `env.ts`) and who handles them in `publish.ts:handleBatch`:

| Message | Handler |
| --- | --- |
| `{ jobId }` | `publish.ts:processJob` |
| `{ importId }` | `imports.ts:detectQueued` |
| `{ checkVersionId, attempt? }` | `guides.ts:runContentChecks` |
| `{ linkCheckToolId }` | `guides.ts:recheckLinks` |
| `{ publishVersionId }` | `publish.ts:publishApproved` |
| `{ backupVersionId }` | `backups.ts:backupVersion` |

Errors: transient (anything that is not a `github.HostError` with `transient=false`) retry with
`delaySeconds: 30 * attempts` while `msg.attempts < 5`; after that `jobId` messages go to `publish.ts:failJob`,
`importId` to `imports.ts:failImport`, everything else is only `console.error("queued work failed", ...)` and acked.

---

## 2. Flows

### a. Publish a tool

```
 git push vX.Y.Z
   |
   +-- GitHub "create" (ref_type tag) -> POST /v1/webhooks/github  (HMAC x-hub-signature-256)
   |      routes/webhooks.ts:onTag ---------------------------+
   +-- GitLab "tag_push" -> POST /v1/webhooks/gitlab (x-gitlab-token)                     |
   |      routes/webhooks.ts:onGitlab -> sync.ts:queueTag ----+                            |
   +-- missed? 6-hourly: sync.ts:pollDueSources -> pollSource -> queueTag                  |
   +-- import wizard "registry" finish: imports.ts:finishImport -> queueTag               |
                                                               v
                        INSERT publish_jobs (status 'queued') + PUBLISH_QUEUE.send({jobId})
                                                               |
                                   publish.ts:handleBatch -> processJob(jobId)
                                     status 'validating', attempts+1
                                     host.tagCommit(tag) -> commit_sha
                                     host.setStatus(sha, pending, "Validating otinstaller.yaml")
                                     host.fileAt("otinstaller.yaml") | heldManifestFor(held)
                                     lib/manifest.ts:parseManifest -> releaseProblems
                                     referencedFiles -> host.fileAt each (README, docs)
                                     guides.ts:renderRelease -> copyImages -> renderRelease
                                     artifactProblems -> hosts/artifacts.ts:checkImage | checkWheel
                                     record() -> tools/sources/versions/publish_jobs in one batch
                                               |                                  |
                                        problems = []                       problems != []
                                               |                                  |
                         guides.ts:storeContent (R2 CONTENT)        status 'rejected'; email
                         setStatus(pending, "Valid; security        templates.rejected; setStatus
                                   scans running")                  (failure, "<code>: <message>")
                         startChecks -> scans.ts:dispatchScan  (tools)
                                     -> guides.ts:queueContentChecks (guides)
```

Step by step:

1. **Tag arrives.**
   - GitHub: `routes/webhooks.ts` `POST /webhooks/github` checks `GITHUB_WEBHOOK_SECRET` with `hmacSha256Hex` /
     `safeEqual` (401 `bad_signature`), caps the body at 5 MB, and for event `create` with `ref_type: tag` calls
     `onTag`. `onTag` ignores tags not matching `sync.ts:RELEASE_TAG` (`^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`),
     uninstalled or suspended installations, and repositories not in `installations.repo_ids` (unless
     `repository_selection = 'all'`). It inserts `publish_jobs` with `delivery_id = x-github-delivery`
     (`ON CONFLICT (delivery_id) DO NOTHING`) and sends `{ jobId }`.
   - The App's `installation` event (`onInstallation`) creates the namespace with `namespaceFor` in status
     `pending_review` (a taken name gets a `-gh` suffix) and `addOwnerIfKnown` adds the sender as owner if they have
     signed in before.
   - GitLab: `POST /webhooks/gitlab` → `onGitlab` finds the source by `project_id`, compares
     `sha256(x-gitlab-token)` with `sources.webhook_secret_hash` (401 `bad_signature`), skips `sync_status = 'paused'`,
     dedupes through `sync.ts:recordEvent` (`sync_events.provider_event_id = gitlab:<uuid>`), ignores deleted tags
     (`after` all zeros), then `sync.ts:queueTag`.
   - `sync.ts:queueTag` refuses a tag that already has a `publish_jobs` row not in `error`, or a `versions` row for
     that version not `rejected`.
   - Poll: `pollDueSources` (every 15 min, sources with `sync_status IN ('ok','error','unavailable')` and
     `last_poll_at` older than 6 h, 50 at a time) → `pollSource`: `host.metadata()` → `applyMeta` (unavailable,
     transfer_pending, archived → deprecated) → `refreshReadme` → `host.listTags(etag)`; at most 3 tags queued
     (`MAX_TAGS_PER_POLL`), tags in `sources.baseline_tags` skipped.
   - Import: `imports.ts:finishImport` in `registry` mode stores the manifest on the source
     (`manifest_mode='registry'`, `registry_manifest_json`) and queues the newest tag with
     `queueTag(..., "import:<id>:<tag>")`.
2. **Queue consumer.** `publish.ts:handleBatch` → `processJob`. If the job is already `scanning` with
   `versions.scan_dispatched_at IS NULL`, it only re-runs `startChecks` (dispatch retry). Otherwise it needs status
   `queued` or `validating`, sets `validating` and increments `attempts`.
3. **Context.** `jobContext` resolves the host and namespace: GitHub via `installations.github_installation_id`
   (`hosts/repo.ts:githubRepo`), GitLab via `sources.connected_by` (`hosts/repo.ts:gitlabRepo`, with
   `gitlabToken` refreshing the connecting user's OAuth token).
4. **Commit status.** `host.tagCommit(tag)` → `publish_jobs.commit_sha`; `host.setStatus(sha, "pending",
   "Validating otinstaller.yaml", <SITE_URL>/dashboard/publish/<jobId>)`. Context is `otinstaller/publish` on both
   hosts (`hosts/github.ts`, `hosts/repo.ts`; GitLab maps pending → `running`, failure/error → `failed`).
5. **Manifest.** `host.fileAt("otinstaller.yaml", sha)`. If absent and the source is `manifest_mode = 'registry'`,
   `imports.ts:heldManifestFor`; if absent otherwise, `manifest_file_missing`. Else `lib/manifest.ts:parseManifest`.
6. **Release rules.** `publish.ts:releaseProblems`: `namespace_not_allowed` (namespace `rejected`/`suspended`),
   `manifest_tag_mismatch`, `manifest_namespace_mismatch`, `manifest_version_exists` (any non-rejected row),
   `manifest_name_taken` (`tools.repo_url` differs).
7. **Referenced files and rendering.** `lib/manifest.ts:referencedFiles` → `host.fileAt` each
   (`manifest_file_missing`), then `guides.ts:renderRelease` (README, `docs.nav`, guide `content.nav`; `content_*`
   problems), `guides.ts:copyImages` (images to R2 with metadata stripped), render again with asset URLs.
8. **Artifact.** Tools: `publish.ts:artifactProblems` → `hosts/artifacts.ts:checkImage` (manifest by digest with an
   anonymous registry token; 401/403/404 → `artifact_image_not_found`, an index without linux/amd64 →
   `artifact_platform_missing`) or `checkWheel` (PyPI JSON; `artifact_package_not_found`,
   `artifact_wheel_mismatch`). Guides: `guides.ts:relatedToolProblems`.
9. **Record.** `publish.ts:record` writes in one `db.batch`: a new `tools` row (`community_packaged` when
   `upstreamOf()` finds a homepage in another repository, so only real wrappers in `osintverse-community`), a GitHub `sources` row (`ON CONFLICT (provider, project_id)`), the `versions` row
   (re-tagging a rejected version reuses its row, takes the manifest, `runtime_kind` and `artifact_ref` from the new
   release, and resets `scan_status = 'pending'`), `publish_jobs` (`status`,
   `error_code`, `error_detail`, `problems_json`) and an `audit_log` row `publish.scanning|rejected`.
10. **Outcome.**
    - Valid: `guides.ts:storeContent` (pages and README in R2, `versions.search_text`), then
      `changelog.ts:captureNotes` (release notes from `host.releaseNotes(tag)`, else the version's section of
      `CHANGELOG.md`, `CHANGES.md` or `HISTORY.md` at the commit; written only when a release webhook has not
      already set them, and never an error), status "Valid; security scans running" (or "Valid; content checks running"), then `startChecks` → `scans.ts:dispatchScan` (tools) or
      `guides.ts:queueContentChecks` (guides). If the manifest moved into the repo, the source switches from
      `registry` to `repo` mode.
    - Invalid: email `notify.ts:templates.rejected` (only when a version row was written), status
      `failure "<first code>: <first message>"`.
11. **dispatchScan** (`scans.ts`): random 32-byte token; stores `versions.scan_token_hash`,
    `scan_token_expires_at = now + SCAN_TOKEN_TTL (1 h)`, `expected_signer_regexp/issuer` from `expectedSigner`
    (GitHub: `https://github.com/<repo>/.github/workflows/...@refs/(tags/<tag>|heads/...)`, issuer
    `https://token.actions.githubusercontent.com`; GitLab: `https://gitlab.com/<repo>//...`, issuer
    `https://gitlab.com`). `dispatchOps(env, "otinstaller-scan", { scan })` POSTs
    `https://api.github.com/repos/<OPS_REPO>/dispatches` with `OPS_DISPATCH_TOKEN` or the App installation token for
    `OPS_INSTALLATION_ID`. Only after a delivered dispatch is `versions.scan_dispatched_at` set.
12. **Failures.** After 5 transient failures `failJob` sets `publish_jobs.status = 'error'`, `error_code =
    'internal_error'`; an undispatched `scanning` version becomes `rejected` (`internal_error`) and the commit status
    is set to `error "The registry could not start the checks; push the tag again"`.

### a2. Publish directly (`ot publish`)

```
 ot publish [path]                                   (cli/internal/cli/publish.go)
   manifest.LoadFile + Validate -> manifest.BundleFiles (manifest, README, pages, every image under the folder)
   POST /v1/publish?namespace=&name=&version=  multipart, one part per file named by its path
     direct.ts:acceptUpload
       uploadTarget: owner/publisher of the namespace (404 namespace_unknown, 403 forbidden, namespace_not_allowed)
       uploadConflicts: manifest_name_taken (repo_url set), manifest_version_exists, publish_in_progress
       overLimit("publish", ns, 20/h)  -> 429 publish_rate_limited
       readBundle: Content-Length <= 25 MiB (413 bundle_too_large), <= 300 files, bundlePath() (400 bundle_invalid)
       parseManifest (400 manifest_invalid with problems); must name the query's ns/name/version
       R2 CONTENT uploads/<jobId>/<path> per file
       INSERT publish_jobs (provider 'direct', repo '<ns>/<name>', tag 'v<version>', namespace_id, bundle_key,
                            submitted_by) + PUBLISH_QUEUE.send({jobId}); email the owners of a GitHub/GitLab namespace
   GET /v1/me/publish-jobs/:id  (polled every 3 s until validation ends, or the outcome with --wait)
```

`processJob` treats a job with `bundle_key` as an upload:
- `jobContext` takes the namespace from `namespace_id` and reads files through `direct.ts:bundleHost`, a `RepoHost`
  over the R2 objects. `tagCommit` returns `""` and `setStatus` does nothing, so the rest of the flow is unchanged.
- No held manifest is looked up and no `sources` row is written. `tools.repo_url` stays NULL: the namespace owns the
  name. Links to other files in the pages render as text (`fileUrlFor` returns null).
- `releaseProblems` gives `manifest_name_taken` when the tool has a `repo_url`. In the other direction, the first
  git job that releases a direct package sets its `repo_url` (`record`), and from then on uploads are refused.
- The version upsert only reuses a `rejected` row. When it changes nothing (two releases of one version at once), the
  job is rejected with `manifest_version_exists`.
- `startChecks` dispatches with `signer: null` and `sourceRepo: ""`; see the scan flow for pinning.
- The upload is deleted after the checks start, on rejection, and in `failJob`. An R2 lifecycle rule on `uploads/`
  removes anything left over.

**Hosted images.** `ot publish --image|--image-archive|--build` first pushes the image to the mirror.
- **Reading.** `cli/internal/oci` reads an OCI layout or a docker-archive. It drops platforms whose blobs aren't in
  the archive and requires linux/amd64.
- **Pushing.**
  - The CLI gets a push token from the mirror's `/token` with Basic `ot:<ot_ token>`.
  - It uploads each blob the repository lacks in 50 MiB PATCHes, then the platform manifests, then the tag `<version>`.
  - It rewrites `runtime.image` to `<mirror>/<ns>/<name>@<digest>`; `--sign` then runs `cosign sign` with a temporary
    `DOCKER_CONFIG`.
- **On the mirror.** Each manifest PUT is recorded in `mirror_pushes` and marked `pending/`. Only the scanner and the
  repository's publishers can read it.
- **Validation.** `artifactProblems` sees the mirror host (`backups.ts:hostedImage`).
  - It reads the image through the `MIRROR` bucket (`imageExists`, `imagePlatforms`) instead of over HTTPS.
  - It refuses another package's repository (`artifact_image_foreign`).
- **Publishing.** `publishVersion` calls `recordHostedImage`: `releaseImage` clears the pending markers (index children
  too), and a `backups` row with `hosted = 1` stands for the image. `releasePlan` never copies such an image, and
  `installFallbacks` never offers it.
- **Clean-up.** Nightly, `queueMirrorSweeps` queues `{mirrorSweepRepo}` for repositories with pushes older than a week.
  `sweepMirrorRepo` keeps the digests of the package's non-rejected versions and backups, with their index children and
  `sha256-*` tags; it deletes other manifests older than a week and unused blobs older than a day (`sweepRepo`).
  `purgeUploads` clears blob uploads idle for a day.

Registry namespaces come from `POST /v1/namespaces` (`direct.ts:createNamespace`, `ot namespace create`):
- Name rules: the slug; no name in `RESERVED_NAMESPACES` or `REGISTRY_RESERVED` (`api/src/lib/reserved.ts`;
  `namespace_reserved`); not taken.
- Accounts: a GitHub or GitLab user's name needs that account linked to the creator; an organisation's or group's is
  refused (`namespace_account_required`). The lookups are `GET api.github.com/users/<name>` (the user's GitHub token,
  else the ops installation's) and GitLab `users?username=` and `groups/<name>`.
- Limits: 3 per user (`namespace_limit`), 5 attempts a day.
- The row is `provider 'registry'`, `provider_owner_id = id`, `pending_review`, `created_by`, plus an owner member.
- `purgeIdleNamespaces` (nightly) deletes ones with no tools, transfers or running jobs after 30 days.

### a3. Trusted publishing from CI

An owner trusts a repository first: `POST /v1/me/namespaces/:ns/trusted-publishers` (`ot namespace trust`, the
dashboard), a `trusted_publishers` row with optional `workflow`, `environment` and `package`.

```
 release workflow (spec/templates/*: the last step when OTINSTALLER_PUBLISH = oidc)
   ot publish --oidc                                 (cli/internal/cli/publish.go, oidc.go)
     ciIDToken: GitHub GET $ACTIONS_ID_TOKEN_REQUEST_URL&audience=otinstaller (bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN)
                GitLab $OTINSTALLER_ID_TOKEN (id_tokens: aud otinstaller)
     POST /v1/auth/oidc/token {id_token, namespace, package}
       lib/oidc.ts:verifyCiToken
         iss -> github | gitlab; discovery + JWKS cached per issuer (refetched for an unknown kid); RS256
         aud otinstaller, exp/nbf/iat (60 s leeway), exp - iat <= 1 day, jti present   (401 oidc_token_invalid)
         claims normalised (CiClaims); the workflow must be in the repository itself:
           GitHub job_workflow_ref <repo>/.github/workflows/<file>@<ref>, GitLab ci_config_ref_uri gitlab.com/<path>//<file>@<ref>
       trusted.ts:exchangeIdToken
         overLimit("oidc_token", provider:repository_id, 30/h); namespace exists and may publish
         repository visibility public                                    (else 403 publisher_not_trusted)
         matchPublisher: (provider, repository, namespace) rows; pinned repository_id/owner_id, workflow,
           environment (case-insensitive), package; pull_request_target / merge_request_event only with an environment
         the publisher's creator is still a member and not banned
         batch: INSERT api_tokens (scopes read,publish, 1 h, namespace_id, package, trusted_publisher_id, oidc_json,
                jti UNIQUE -> 401 oidc_token_reused) + pin ids + audit token.create_ci (actor_kind github|gitlab)
     the minted token: image push (mirror canPush: its namespace and package only), then
     POST /v1/publish   authenticate: a restricted token counts only here and on GET /me/publish-jobs/:id
       direct.ts:acceptUpload
         uploadTarget: the token's namespace and package
         sameRelease: a job for provider + repo_id + v<version> in the namespace, queued..published
                      -> 200 {already_received: true, job_id}
         uploadConflicts: manifest_name_taken unless tools.repo_url is this repository
         INSERT publish_jobs (provider/repo/repo_id from the claims, delivery_id ci:<id>, tag + commit_sha from a tag
                              ref, else v<version> + NULL; trusted_publisher_id, ci_json, bundle_key)
```

`processJob` then treats the job as that repository's release: it is a bundle job (files from R2, no `sources` row,
no commit status), but `fileUrlFor` links into the repository at the commit or tag, `releaseProblems` and `record` use
`repoUrl(provider, repo)` for name ownership, and `startChecks` dispatches `expectedSigner(provider, repo, tag)`, as
for a tag. `onTag` skips a tag a CI run already uploaded, and an upload of a release the App's webhook already queued
answers `already_received`, so a repository with both doesn't fail one of them.

### b. Scan

```
 API (dispatchScan)        registry-ops scan.yml               API
   | repository_dispatch      |                                 |
   | otinstaller-scan ------> | python3 ops/scanner/scan.py     |
   |  client_payload.scan     |   request.json --post           |
   |                          | scan.py:main -> scan()          |
   |                          |   scan_docker | scan_pipx       |
   |                          |   check_image_signature         |
   |                          |   trivy, GuardDog (pipx)        |
   |                          |   smoke() --network none|bridge |
   |                          | scan.py:post ------------------>| POST /v1/internal/scans
   |                          |                                 | loadVersion(token hash,
   |                          |                                 |   unexpired, 'scanning')
   |                          |                                 | review.ts:parseResults
   |                          |                                 | scans.ts:applyScanResults
   |                          |                                 |  verdict(): fail|warn|pass
   |                          |                                 |  fail: rejected, commit
   |                          |                                 |    failure, email rejected
   |                          |                                 |  ns active: publishVersion
   |                          |                                 |    ({backupInline: true})
   |                          |                                 |  else: awaiting_review,
   |                          |                                 |    email in_review
   |                          |<------ { status, verdict,       | releasePlan (if published)
   |                          |          backup? }              |
   |                          | backup.run_job(answer.backup) ->| POST /internal/backups/:run
```

1. `ops/workflows/scan.yml` listens for `repository_dispatch` types `otinstaller-scan`, `otinstaller-backup`,
   `otinstaller-drill`; logs in to the mirror with crane when `MIRROR_PUSH_TOKEN` is set; writes
   `toJSON(github.event.client_payload)` to `request.json`; runs `python3 ops/scanner/scan.py request.json --post`.
2. `scan.py:main` routes `backup` payloads to `backup.run_backup_request`, `drill` to `backup.drill`, otherwise
   `scan()`. `scan()` returns empty results for guides. Docker: `scan_docker` (`check_image_signature` with the
   expected signer plus `signer_identities` to tell "signed by someone else" from unsigned; `trivy` vuln and secret
   scan; SBOM). pipx: `scan_pipx` (download by hash, `check_wheel_provenance` against `source_repo` or
   `upstream_repo`, Trivy on python:3.12-slim, GuardDog). Then `smoke()` runs `test_input` in the same sandbox as
   `ot`, `--network bridge` only when `network_egress` is true, and passes when the exit code equals
   `expect_exit_code`.
3. `scan.py:post` POSTs results to `callback_url` with `Authorization: Bearer <callback_token>`.
4. `routes/review.ts POST /internal/scans`: 413 over 256 KB; `scans.ts:loadVersion` with
   `scan_token_hash = sha256(token) AND scan_token_expires_at > now AND status = 'scanning'` (else 401
   `invalid_scan_token`); `parseResults` (400 `invalid_scan_results`); `scans.ts:applyScanResults`.
5. Direct uploads first go through `scans.ts:pinSigner`. The scanner was sent `expected_signer: null`, so it verified
   any keyless signature (`check_any_signature`) and reported every identity in `signature.identities`.
   - The pin is the signer of the tool's first non-rejected signed version. `signerKey` drops a trailing `@refs/...`,
     so a CI identity stays the same across tags and branches.
   - A reported identity equal to the pin (and with the same issuer) is recorded. If none matches, the signature
     becomes `fail` (`signature_mismatch`).
   - With no pin yet, more than one distinct signer fails as `signature_ambiguous`.
   - Wheels work the same way, with `pypi:<kind>:<repo>/<workflow>` identities.
6. `scans.ts:verdict(results, previouslySigned)`:
   - fail `signature_mismatch` (signature status `fail`)
   - fail `signature_dropped` (unsigned while an earlier published/yanked version was signed)
   - fail `malware_suspected` (`malware.count > 0`)
   - fail `secrets_found` (`secrets.count > 0`)
   - fail `smoke_test_failed`
   - warn when `fixable_critical + fixable_high > 0`, else pass.
7. `applyScanResults` inserts `scans` rows (`signature`, `vuln`, `malware` (malware+secrets), `smoke`, optional
   `sbom`) and clears the token (single use). On fail: `versions.status = 'rejected'`, `scan_status = 'fail'`,
   `rejected_reason = <code>`; `publish_jobs` `rejected` with `error_code/error_detail`; audit `scan.rejected`;
   `commitStatus(failure, "<code>: <message>")`; email `templates.rejected` (key `rejected:<versionId>`).
   Otherwise `scan_status`, `signer_identity`, `signer_issuer` are stored, and:
   - namespace `active` → `scans.ts:publishVersion(env, id, { backupInline: true })`;
   - otherwise `versions`/`publish_jobs` → `awaiting_review`, `commitStatus(pending, "Scans passed; new publisher
     awaiting review")`, email `templates.inReview`.
8. `publishVersion`: `versions.status = 'published'`, `published_at`; `publish_jobs` `published`;
   `tools.latest_version_id = pickLatest(...)` (highest stable, else highest prerelease); if latest,
   `latestMetadata` rewrites `tools` summary/categories/tags/readme_text, `tool_io`, `tool_secrets`,
   `tool_guides`; `commitStatus(success, "Published <ref>@<v>")`; when not `backupInline`, queues
   `{ backupVersionId }`; email `templates.published` (mentions fixable vulns when `scan_status = 'warn'`).
9. The callback answers `{ status, verdict, backup? }`; `backup` comes from `backups.ts:releasePlan` only when the
   status is `published`. `scan.py:main` then calls `backup.run_job(answer["backup"], work)` (see flow d).

### c. Guide publish

```
 processJob (kind: guide) -> storeContent -> queueContentChecks
     versions.scan_dispatched_at = now, scan_token_expires_at = now + 1 h
     PUBLISH_QUEUE.send({ checkVersionId })
        |
 handleBatch -> guides.ts:runContentChecks(versionId, attempt)
     attempt 0: checkPendingLinks (each distinct URL once, <= 300, HEAD then GET, 10 s timeout)
                chooseUrlScans (one link per host, <= 20)   [only with CF_URLSCAN_*]
     every attempt: submitUrlScans, collectUrlScans
        still running/queued and attempt < 5 -> send({checkVersionId, attempt+1}, delay 60 s)
     countDeadLinks; findPersonalData over every page in R2 CONTENT
     settle():
        malicious link -> rejected 'content_link_malicious', commit failure, email rejected
        else scans rows 'links' (pass|warn) + 'pii' (pass|warn), scan_status pass|warn
        ns active and no PII  -> publishVersion (queues backupVersionId)
        else                  -> awaiting_review; commit pending; email contentReview | inReview
```

1. Validation is the same as a tool (flow a steps 1–9); rendering problems (`content_raw_html`,
   `content_page_too_large`, `content_image_type`, `content_image_too_large`, `content_images_too_large`,
   `guide_related_tool_unknown`) reject at that stage.
2. `guides.ts:queueContentChecks` sets the same expiry columns a scan uses, so `scans.ts:expireStaleScans` closes a
   check that never finishes.
3. `guides.ts:runContentChecks`: requires `versions.status = 'scanning'` and `kind = 'guide'`.
   - Links: `checkPendingLinks` → `checkUrl` (401/403/429 count as alive; `page_links.status` ok/dead/...).
   - URL Scanner (only when `CF_URLSCAN_ACCOUNT_ID` and `CF_URLSCAN_TOKEN` are set): `chooseUrlScans`,
     `submitUrlScans` (429 waits for the next round), `collectUrlScans`; up to `URLSCAN_ROUNDS = 5` rounds a minute
     apart; unfinished scans end as verdict `unknown` and are not held against the author.
   - PII: `content.ts:findPersonalData` on each page's markdown (emails outside example domains, phone numbers,
     capitalised names on a line with a street address).
4. `guides.ts:settle`: a URL Scanner `malicious` link rejects; dead links only warn; any PII hit always sends the
   release to review, even from an active namespace (`templates.contentReview`). It shows under `content_review` in
   `GET /v1/admin/review-queue`; decide with `POST /v1/admin/versions/:id/approve|reject`.
5. Nightly: `queueNightlyLinkChecks` → `{ linkCheckToolId }` → `recheckLinks` → `updateLinkHealth`
   (`tools.dead_link_ratio`, `needs_update = ratio > 0.2`).
6. Guides are normally released with `ot release X.Y.Z` (`cli/internal/cli/release.go`: clean tree, unused tag,
   rewrite `version:`, validate, commit, annotated tag, `git push --atomic`).

### d. Backups

```
 Release path (inline):  POST /internal/scans -> publishVersion(backupInline) -> releasePlan
                          -> answer.backup -> scan.py -> backup.run_job
 Release path (queued):   publishVersion() -> send({backupVersionId}) -> backupVersion
                          -> releasePlan -> dispatchBackups -> dispatchOps("otinstaller-backup")
 Backfill (*/15):         backfillBackups -> releasePlan(..., "manual") x5 -> dispatchBackups
 Weekly (Mon 04:41):      weeklyBackups -> createRun(git, weekly) -> dispatchBackups (20 per event)
 Admin:                   POST /admin/tools/:ns/:name/:version/backup [{"dispatch": false}]

  createRun: backup_runs (pending, token_hash, expires_at) + backups rows (pending)
             items[] with signed PUT URLs (signedUrl: R2 SigV4 or apiObjectUrl via the Worker)
         |
  registry-ops backup.py:run_job -> mirror_image (crane copy + copy_signature_tags)
                                  | backup_wheel -> upload(signed URL)
                                  | backup_git  -> make_bundle -> upload(signed URL)
         |  POST /v1/internal/backups/:run  {items:[{id,status,size_bytes,sha256,...}]}
         v
  backups.ts:completeRun: BACKUPS.head (size, wheel sha256) | mirror/registry.ts:imageExists
                          backups -> stored | too_large | failed; run -> completed
                          scheduleDeletion if removed meanwhile; pruneWeekly (keep 4)
                          too_large -> email templates.backupTooLarge
```

1. **Plan.** `backups.ts:releasePlan(versionId)` returns null unless the version is `published`/`yanked` and the
   tool not `removed`. Items not already `stored`:
   - image (`docker` runtime pinned by digest): location `[private/]<ns>/<name>@<digest>`, target
     `<MIRROR_HOST>/<repo>`; public only when `osiApproved(manifest.license)`.
   - wheel: `wheels/<ns>/<name>/<sha256>.whl`.
   - git when `gitEligible` (`tools.git_backups = 1`, a source URL, `sync_status != 'unavailable'`, public):
     `git/<provider>/<project_id>/<YYYY-MM-DD>-v<version>.bundle`.
   `createRun` writes `backup_runs` (`trigger` release/weekly/manual, `expires_at` = 3 h release or 12 h weekly) and
   `backups` rows, and returns `{ run_id, ref, complete_url, token, expires_at, items }`. `max_bytes`: image 2 GB,
   wheel 1 GB, bundle 500 MB.
2. **Signed URLs.** `backups.ts:signedUrl`: with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` a SigV4
   presigned URL straight to R2 (`lib/presign.ts:presignSigV4`); otherwise `apiObjectUrl` →
   `PUT/GET /v1/internal/backups/objects/*` through the Worker (100 MB request cap).
3. **Dispatch.** `dispatchBackups(plans)` → `dispatchOps(env, "otinstaller-backup", { backup: { jobs } })`; on
   failure runs and pending items become `failed` with the error.
4. **Copy.** `ops/scanner/backup.py:run_job` per item: `mirror_image` (crane copy by digest, then
   `copy_signature_tags` for `sha256-<hex>.sig/.att/.sbom`; layers over 90 MB pushed in 50 MB chunks with
   `push_blob_chunked`), `backup_wheel` (`find_wheel` reuses the scan's download), `backup_git` (`make_bundle` from a
   mirror clone, `bundle_heads`), each `upload`ed; then `post_json(complete_url, token, {items})`.
5. **Check.** `routes/backups.ts POST /internal/backups/:run` (≤ 10 items) → `backups.ts:completeRun`: run must match
   `token_hash`, be unexpired and `pending`/`dispatched` (else 401 `invalid_backup_token`). For each row:
   R2 objects are `head`ed (missing → `failed` "the upload did not arrive"; over the limit → deleted, `too_large`;
   wheel hash mismatch → deleted, `failed`); images need `mirror/registry.ts:imageExists`. Run → `completed`,
   audit `backup.completed`; `scheduleDeletion` if the tool/version was removed meanwhile; `pruneWeekly` keeps the
   last `KEEP_WEEKLY = 4` weekly bundles; `too_large` items email owners (`templates.backupTooLarge`).
6. **Expiry.** `expireRuns` (every 15 min): runs past `expires_at` → `expired`, their pending items `failed`
   ("the backup job did not report back").
7. **Backfill.** `backfillBackups` (every 15 min): up to 5 published/yanked docker/pipx versions with no image/wheel
   backup in `stored`, `pending` or `too_large`, and no `backup_runs` row in the last 24 h (`BACKFILL_RETRY`). Git
   bundles are not backfilled (the weekly run covers them).
8. **Weekly.** `weeklyBackups`: every tool with a latest version, active namespace, `git_backups = 1`, source not
   `unavailable`/`paused`, public; `<date>-weekly.bundle`; dispatched 20 per event.
9. **Install fallbacks.** `backups.ts:installFallbacks` adds `mirror_image` / `wheel_url` to the manifest response
   for `stored`, `visibility = 'public'`, `delete_after IS NULL` backups. The wheel is served by
   `routes/backups.ts:wheelResponse` at `/v1/tools/:ns/:name/:version/wheel/:file`.
10. **Takedowns and holds.** `scheduleDeletion` hides images on the mirror at once (`hideImage`, writes
    `hidden/<name>[@digest]` in R2 MIRROR; a whole-package removal hides both public and private repos) and sets
    `delete_after = now + TAKEDOWN_GRACE (14 days)` unless `tools.legal_hold`. `purgeBackups` (nightly, 200 at a
    time) deletes due backups (`deleteImage` or `BACKUPS.delete`), status `deleted`. `setLegalHold` clears
    `delete_after`; releasing a hold reschedules deletion. `setGitBackups(false)` sets `delete_after = now` on git
    bundles (deleted that night).
11. **Restore.** Owner: `POST /v1/packages/:ns/:name/backups/restore` → `restoreLink` (latest stored bundle, 1 h GET
    URL, commands: `git bundle verify`, `git clone --mirror`, `git remote set-url`, `git push --mirror`), then
    `POST /v1/packages/:ns/:name/source` (`routes/sources.ts:switchSource`).
12. **Drill.** `startDrill` (monthly, or `POST /v1/admin/backups/drill`): random stored git bundle and random public
    mirrored image of a published version → `restore_drills` row (`dispatched`, `expires_at = now + 6 h`) →
    `dispatchOps("otinstaller-drill", { drill })` → `backup.py:drill` (`restore_bundle`: download, SHA-256, clone,
    push into an empty repo, fsck, compare refs; `pull_image`: pull by digest, cosign verify) → `POST
    /v1/internal/drills/:id` → `completeDrill` → `finishDrill`. Anything but `pass` (including `expireDrills` after
    6 h, or a failed dispatch) emails admins (`templates.drillFailed`, key `drill:<id>`).

### e. Install and run in `ot`

```
 ot install ns/name[@v]
   cli/packages.go:(*App).install
     api.Client.Manifest -> GET /v1/tools/:ns/:name/:version/manifest  (default "latest")
        410 tool_removed            -> exit 4
        404                         -> exit 2 "not found in the registry"
        status 'removed'            -> exit 4
     trustWarnings (unsigned, scan warn, broken, unverified publisher, source gone)
     manifest.Validate(doc)         -> invalid: exit 4
     runner.(*Runner).Install
        docker: installDocker
          engine pull <image@sha256>  -- refused (401/403/404/denied/...) and mirror_image has the
                                         same digest -> engine pull <mirror_image>
          cosign verify --certificate-identity <signer> --certificate-oidc-issuer <issuer> <pulled>
             missing cosign: warning only; failure: TrustError (exit 4)
        pipx: FetchWheelWithBackup -> FetchWheel (PyPI JSON, sha256 match, re-hash)
                gone (403/404/410/no matching file) + wheel_url -> download(wheel_url, same sha)
              sandboxed: buildPythonImage -> ot-local/<ns>-<name>:<version>
              --native or no engine: installPipxNative
     state.Load -> st.Installed[ref] = inst -> st.Save      (state.json, records from_backup)
     POST /v1/installs {tool, version}   (unless OT_NO_TELEMETRY / config telemetry false; 3 s)

 ot run ns/name [u:x d:x --input v ...]
   cli/run_cmd.go -> ensureInstalled (refuses removed versions: /v1/removed list, refreshed hourly)
   loadSecrets (env var wins, else keychain "osintverse-ot")
   (*App).execute -> results.Start(Dir(--results-dir), tool, target, case, format)
   runner.(*Runner).Run -> BuildCommand -> runContainer -> ContainerArgs -> engine run ...
   envelope.ParseOutput(output_format, stdout) -> Envelope{...}
   results.(*Run).Finish(meta) -> <stem>.meta.json (+ lazy .stderr.txt); "Saved <path>" on stderr
```

1. `cli/internal/cli/packages.go:(*App).install` → `api.(*Client).Manifest` →
   `GET /v1/tools/:ns/:name/:version/manifest` (`api/src/index.ts`). The route uses `catalog.ts:findTool` (with
   aliases → `moved_to`), `findVersion` (`latest` = `tools.latest_version_id`; exact versions include `published`,
   `yanked`, `removed`), and for non-removed versions `backups.ts:installFallbacks`. It returns `signer_identity`,
   `signer_issuer`, `scan_status`, `health`, `verified_publisher`, `source_unavailable`, `manifest`,
   `mirror_image`, `wheel_url`. Missing package: `catalog.ts:notFound` answers 410 `tool_removed` or 404
   `tool_not_found`.
2. CLI refusals: 410 → `ExitTrust` (4); 404 → `ExitUsage` (2); `status == "removed"` → 4; `manifest.Validate`
   problems → 4. `MovedTo` prints a note. `trustWarnings` prints warnings only.
3. `runner/install.go:(*Runner).Install` (guides are refused with a `UsageError`):
   - `installDocker`: `requireEngine` (`RuntimeMissingError`, exit 5); image must contain `@sha256:`
     (`TrustError`); `<engine> pull <image>`; on failure it falls back only when `opt.MirrorImage != ""`,
     `sameDigest(image, mirror)` and the pull output matches `unavailable`
     (`denied|forbidden|unauthorized|not found|manifest unknown|name unknown|error from registry|40[134]`).
     Then, if `SignerIdentity` is set and `cosign` is on PATH, `cosign verify --certificate-identity <id>
     --certificate-oidc-issuer <issuer> <pulled ref>`. When the mirror was used, `state.Installed.LocalImage` is the
     mirror reference and `FromBackup = true`.
   - pipx: `FetchWheelWithBackup` → `FetchWheel` (`<PyPIBase>/pypi/<pkg>/<ver>/json`, the `bdist_wheel` whose
     `digests.sha256` equals `wheel_sha256`, `download` re-hashes) — fallback when `gone(err)` (403/404/410 or the
     "no wheel for ... matches" `TrustError`) and `wheel_url` ends in `.whl`. Then `buildPythonImage`
     (`<engine> build --pull -t ot-local/<ns>-<name>:<version>`) or `installPipxNative` (ot's own `PIPX_HOME`,
     `PIPX_BIN_DIR`).
4. `state.Load` / `(*State).Save` (`cli/internal/state/state.go`; data dir `OT_HOME` → `%APPDATA%\ot` → `~/.ot`).
5. Install ping: `api.(*Client).InstallPing` (anonymous, through `anon()`) → `POST /v1/installs` `{tool, version,
   client}` (counted once per address, version and day; per-day counters in `install_counts` and `install_clients`;
   204 even when nothing matched) unless `Config.TelemetryEnabled()` is false (`OT_NO_TELEMETRY` set, or `telemetry: false`
   in `config.json`). Local manifests never ping and skip signature checks.
6. Run: `cli/run_cmd.go` parses its own args; `cli/run.go:(*App).ensureInstalled` refuses a removed installed
   version (`removedList(ctx, time.Hour)` from `GET /v1/removed`, cached in `<ot home>/cache/removed.json`;
   `removal()` matches a whole-package entry with an empty version) and offers to install a missing package.
7. `runner/runner.go:(*Runner).Run`: `context.WithTimeout(timeout_seconds)`; `args.go:BuildCommand`; secrets become
   `NAME=value` in the child env only; `runContainer` (name `ot-<12 hex>`, `kill` on cancel) or `runNative`.
8. `ContainerArgs` produces exactly:

   ```
   run --rm --name ot-<hex>
     --read-only --tmpfs /tmp:rw,size=256m
     --cap-drop ALL --security-opt no-new-privileges
     --pids-limit 256 --memory 1g --cpus 2
     --user 65534:65534 -e HOME=/tmp
     [--network none]                 unless manifest network.egress is true (missing means offline)
     [-e SECRET_NAME ...]             names only; values come from the child environment
     [-v <out-dir>:/out:rw]           with -o/--out-dir
     --entrypoint <command[0]> <image> <command[1:]...>
   ```

   `<image>` is `LocalImage` when set (mirror reference or `ot-local/...`), else `runtime.image`.
9. Deadline exceeded → `TimeoutError` (exit 124). `envelope.ParseOutput(output_format, stdout)` (json, jsonl, csv,
   text; picks up `entities` when the tool already emits them) → `envelope.Envelope{Envelope: 1, Tool, Runtime,
   Input, StartedAt, DurationMS, ExitCode, Entities, Raw, Warnings}`.
10. Saving (`cli/run_cmd.go:(*App).execute`): `results.Start` makes
    `<results dir>/[cases/<case>/]<tool>/<target>/<YYYYMMDD-HHMMSS>_<tool>_<target>_<id>`; stdout is teed into the
    raw file; stderr goes to a lazily created `.stderr.txt`; `(*Run).Finish(meta)` writes `.meta.json` with
    `results.StatusComplete|Failed|Timeout|Interrupted`. Results dir: `--results-dir`, `OT_RESULTS_DIR`,
    `OTINSTALLER_RESULTS_DIR`, else `./results`.

### f. Sign-in

```
 Web:  site -> /v1/auth/:provider/login?redirect=...  (lib/api.ts:signInUrl)
         sets ot_oauth_state cookie (state|provider|redirect, path /v1/auth, 10 min)
         github/gitlab authorize URL | osintverse: osintverseLogin (nonce, PKCE, ot_oidc cookie)
       provider -> /v1/auth/:provider/callback
         state check (400 oauth_state_mismatch) -> exchangeCode -> fetchUser
         signIn(env, p, who, tokens, currentUserId) -> startSession -> Set-Cookie ot_session
         redirect to safeRedirect(redirect)   (same origin as SITE_URL, else /dashboard)

 CLI:  ot login [--gitlab | --osintverse]
         POST /v1/auth/device/start {provider}
            github/gitlab: provider device flow -> {device_code, user_code, verification_uri, ...}
            osintverse:    device.ts:startOsintverseDevice (code BCDF-GHJK, 10 min, 5 s interval)
         poll POST /v1/auth/device/token {provider, device_code, token_name, scopes?}
            pending | slow_down (+5 s) | ok -> signIn(..., null) -> mintApiToken(scopes) -> "ot_..." token (scoped = 1)
         keys.Set("OTINSTALLER_TOKEN", token)  (keychain service osintverse-ot)

 Every request: routes/auth.ts:authenticate
   Bearer ot_* -> api_tokens.token_hash = sha256(token), not revoked/expired, user not banned
   else cookie ot_session -> sessions.token_hash, expires_at > now
```

1. Web OAuth (`routes/auth.ts`): `GET /auth/:provider/login` (`provider()` accepts github, gitlab, osintverse; 404
   `unknown_provider`), `oauthClient` reads the client secrets (503 `not_configured` when missing). GitLab adds the
   `api` scope only with `?scope=api` (`gitlab.authorizeUrl`).
2. `GET /auth/:provider/callback`: GitHub/GitLab `exchangeCode` → `fetchUser`; OSINTverse `osintverseCallback` →
   `osintverse.exchangeCode` (PKCE) → `verifyIdToken` (nonce) → `fetchUser`. `signIn` → `startSession`
   (`sessions` row, cookie `ot_session`: httpOnly, Secure, SameSite=Lax, path `/`, 30 days) → redirect.
3. `signIn` linking rules: an existing `accounts` row for `(provider, provider_user_id)` signs in as its user, but
   409 `account_already_linked` when a different user is signed in. A new provider account is linked to the signed-in
   user (409 `provider_already_linked` if they already have one for that provider) or creates a new user. No linking
   by email. Only a session cookie counts as signed in here (`linkingUserId` in `routes/auth.ts`): a callback that
   carries an `ot_` API token links nothing, or any token holder could attach their own account to the token's owner.
   Device logins pass `currentUserId = null` and never link. Provider tokens are stored AES-GCM encrypted
   with `TOKEN_ENC_KEY` (OSINTverse stores none).
4. CLI device flow: `cli/internal/cli/login.go:(*App).loginCmd` → `api.(*Client).StartDeviceLogin` /
   `PollDeviceLogin`. OSINTverse uses the registry's own flow (`routes/device.ts`): the user opens
   `/v1/auth/osintverse/device`, types the code, signs in on osintverse.com (`osintverseLogin` with the device id in
   `ot_oidc`), then approves on a confirmation page (`authorizeDevice`, `/auth/osintverse/device/confirm`); the next
   poll (`pollOsintverseDevice`) gets an `ot_` token.
5. API tokens: `mintApiToken` = `"ot_" + randomToken(30)`, stored as `sha256` with scopes `read,publish`;
   `GET/POST/DELETE /v1/me/tokens`. `OTINSTALLER_TOKEN` in the environment overrides the keychain.
6. `authenticate` runs on every request (registered first in `authRoutes`). `requireUser` (401 `unauthenticated`),
   `review.ts:requireReviewer` / `requireAdmin` (403), `sources.ts:requireMember`.
7. CORS (`index.ts`): only `Origin == SITE_URL` gets `credentials: true`; any other origin gets `*` without
   credentials.

### g. Review

```
 new namespace (pending_review) + release passes scan/checks
   -> versions/publish_jobs 'awaiting_review'; commit pending "...new publisher awaiting review"
   -> reviewer: GET /v1/admin/review-queue  (queue[] per namespace, content_review[])
   -> POST /v1/admin/namespaces/:ns/approve {notes}
        namespaces.status 'active', reviewed_by/at, audit namespace.approve
        PUBLISH_QUEUE.sendBatch({publishVersionId}) in chunks of 100
   -> handleBatch -> publish.ts:publishApproved -> scans.ts:publishVersion
        (awaiting_review + namespace active only) -> commit success, email, {backupVersionId}
```

1. `routes/review.ts GET /admin/review-queue`: namespaces `pending_review` with awaiting versions (members, scans,
   license, ethics), plus `content_review` (awaiting versions in active namespaces: guides with PII). A registry
   namespace carries `creator` (its creator's login and linked accounts) instead of a `profile_url`.
2. Decisions on a namespace: `POST /admin/namespaces/:ns/approve` (above), `/request-changes {notes}` (awaiting
   versions → `rejected` `changes_requested`, email `templates.changesRequested`; namespace stays in review),
   `/reject {reason}` (namespace `rejected`, versions `namespace_rejected`, commit failure, email
   `templates.namespaceRejected`). Both close the versions' `publish_jobs` too (`closeWaitingJobs`), so the dashboard
   and `ot publish --wait` see the decision. All 409 `not_pending` unless the namespace is `pending_review`.
3. Single versions (active namespaces only, else 409 `namespace_in_review`): `POST /admin/versions/:id/approve`
   (`publishVersion` inline) or `/reject {reason}` (`review_rejected`, commit failure, email).
4. Admin only: `/admin/namespaces/:ns/verify` (`verified = 1`), `/admin/namespaces/:ns/suspend {reason}`.
5. `ops.ts:dailyDigest` emails reviewers about namespaces waiting > 2 business days and open reports > 48 h.

### h. Takedown, removal, yank and deprecate: effects on install

| Action | Code | Registry effect | `ot` effect |
| --- | --- | --- | --- |
| Yank / unyank (`POST /v1/tools/:ns/:name/:version/yank|unyank`, `ot yank`) | `trust.ts:setYanked` → `recomputeLatest` | `versions.status = 'yanked'`; leaves `@latest` and search metadata | Exact version still installs (`findVersion` includes `yanked`); backups and fallbacks stay |
| Deprecate (`POST/DELETE /v1/tools/:ns/:name/deprecate`, `ot deprecate`; also `sync.ts:applyMeta` on an archived repo) | `routes/trust.ts` | `tools.status = 'deprecated'`, `deprecated_message`, `deprecated_replacement`; still visible and listed | `ot search` badge "deprecated", `ot info` prints "Deprecated: ..."; `ot install` does not warn |
| Remove a version (`POST /v1/admin/tools/:ns/:name/:version/remove`) | `trust.ts:removeVersion` → `recomputeLatest` → `backups.ts:scheduleDeletion` → email `templates.removed` | `versions.status = 'removed'` with category/reason; optional namespace suspension; mirror image hidden; backups deleted after 14 days unless legal hold | Manifest answers `status: removed` (no manifest) → exit 4; installed copies refused by `ensureInstalled` and warned daily by `warnRemoved` |
| Remove a package (`POST /v1/admin/tools/:ns/:name/remove`) | same, `version = null` | `tools.status = 'removed'`, every version removed; both mirror repos hidden | `findTool` no longer matches (`VISIBLE`), `notFound` → 410 `tool_removed` → exit 4 |
| Source unavailable (`sync.ts:applyMeta`) | `sources.sync_status = 'unavailable'` | hidden from search (`LISTED`), still installable; restored automatically within 30 days | warning "source repository ... is no longer available" |

Removal list: `GET /v1/removed` → `trust.ts:transparency` (cached 600 s). The CLI refreshes it hourly before runs
and daily for the warning (`cli/internal/cli/trust.go:removedList`).

### i. Anonymous reads: edge cache and site SSR

```
 request -> export default fetch -> edge-cache.ts:edgeCached
    EDGE_CACHE == "off" | method != GET | has Authorization | has Cookie  -> app.fetch (D1)
    key = URL with sorted params + __cors=site:<origin>|any + __epoch=<cache epoch, reread every 30 s> -> caches.default.match(key)
       hit  -> restore Cache-Control from x-ot-cache-control, x-edge-cache: hit
       miss -> app.fetch -> store when 200 + "public" + max-age>0 + no set-cookie (waitUntil put)

 site SSR page -> lib/api.ts:api() (server: no credentials, no Origin) -> API (key __cors=any)
              -> page.ts:cacheFor(Astro, s) -> Cache-Control: public, max-age=min(s,60), s-maxage=s
 site islands (browser) -> api() with credentials: "include" -> bypasses edge cache (cookie)
```

1. `api/src/edge-cache.ts:edgeCached` wraps the whole API fetch handler. Stored responses keep their own
   `Cache-Control` lifetime; the original header is put back on hits because the zone's Browser Cache TTL rewrites
   it. There is no purge code: removals and yanks move the cache epoch on (`trust.ts`, `bumpCacheEpoch`), and the
   new key makes every older entry unreachable within 30 seconds.
2. `catalog.ts:cached(c, seconds)` sets `public, max-age=<seconds>`. Current values (= worst-case staleness):

   | Endpoint | max-age |
   | --- | --- |
   | `/types` | 86400 |
   | `/tools`, `/guides` (search) | 60 |
   | `/tools/:ns/:name`, `/tools/:ns/:name/versions` | 60 |
   | `/tools/:ns/:name/:version/manifest` | 60 for `latest`, 3600 for an exact version |
   | `/tools/:ns/:name/:version` | 3600 |
   | `/tools/:ns/:name/:version/scans` | 300 |
   | `/namespaces/:ns` | 300 |
   | `/pivots`, `/removed` | 600 |
   | `/latest` | 3600 |
   | `/tools/:ns/:name/docs`, `/guides`, `/readme` | 600 |
   | `/guides/:ns/:name[/:version]` | 60 (`latest`) / 3600 |
   | `/tools/:ns/:name/:version/wheel/:file` | 86400 (header set in `wheelResponse`) |
   | `/assets/:sha256.ext` | 31536000, immutable (`lib/images.ts`) |
   | `/health`, error responses, anything `private, no-store` | not stored |

3. Site (its own repository; `lib/api.ts:api`): server-side calls send no cookie; browser calls (islands) send
   `credentials: "include"`. `lib/page.ts:cacheFor` caps browser `max-age` at 60 s and sets `s-maxage`
   (tool pages 60, search 60, home 300, category/input 600, docs layout `max-age=300, s-maxage=3600`). The code
   does not put site pages in `caches.default`; `s-maxage` only matters to a CDN cache rule. Pages with a query
   string get `noindex` (`Base.astro`), filter links are `rel="nofollow"`, `robots.txt` disallows `/*?`.

### j. `ot self-update` and the install scripts

```
 curl -fsSL https://get.otinstaller.com/ot | sh
   ops/get/worker.js: /ot|/ot.sh|/install.sh -> install.sh ; /ot.ps1|/install.ps1 -> install.ps1
     fetch github.com/<RELEASE_REPO|OTInstaller/ot>/releases/latest/download/<file> (cacheTtl 300)
     upstream error -> 502 with a script that prints an error and exits 1 (ps1: throw)
     /ot/latest -> github.com/<RELEASE_REPO>/releases/latest (redirect: manual) -> tag from Location
       ^vX.Y.Z$ -> {"version": tag}, max-age 3600 ; else 502 latest_unknown
     other paths -> 302 https://otinstaller.com/docs/getting-started
   install.sh: tag = OT_VERSION or api.github.com/repos/<OT_RELEASE_REPO>/releases/latest
     download ot_<ver>_<os>_<arch>.tar.gz, checksums.txt, checksums.txt.sig
       (from OT_DOWNLOAD_BASE, else the GitHub release)
     Ed25519 verify with OpenSSL 3 (else checksum only, with a warning) -> sha256 check -> install

 ot self-update [--check]
   cli/selfupdate.go -> selfupdate.New (needs build-time PublicKey, else exit 2)
     Updater.Latest -> LatestVersion(get.otinstaller.com/ot/latest) -> assets named under
                       github.com/<Repo>/releases/download/<tag>/ ; on any failure api.github.com/repos/<Repo>/releases/latest
     Newer(tag, Version)? (so never a downgrade) -> Download: checksums.txt + .sig -> VerifyChecksums (Ed25519)
        -> ChecksumFor(archive) -> sha256 of archive -> extract
        any mismatch -> exit 4 "update refused: ..."
     selfupdate.Replace(exe): temp file next to exe; on Windows exe -> exe.old first

 ot outdated (after the table)
   latestOT: <ot home>/cache/ot-latest.json younger than 24 h? use it : selfupdate.Checker().Latest (3 s), saved
     either way (a failure waits a day too); skipped for dev builds, ot mcp, CI and OT_NO_UPDATE_CHECK=1
   Newer(latest, Version) -> "note: ot vX is out (you have vY); `ot self-update` installs it" on stderr
```

### k. Agents: `ot mcp`, unattended runs and the remote MCP server

The design is [docs/agent-friendly-plan.md](../agent-friendly-plan.md); the rules live in `cli/internal/agent/`.

```
 MCP client (Claude, Cursor, Codex, VS Code, Gemini CLI)
   | stdio
   v
 ot mcp (cli/internal/cli/mcp_cmd.go: AgentMode = true, agent.LoadPolicy)
   read-only tool (search_tools, get_run, suggest_pivots, ...) -> same code as the CLI command -> structured result
   run_tool / run_all / run_playbook / install_tool / uninstall_tool:
     agent.Session.DecideRun(manifest, inputs)
       policy off, tool denied, rate limit hit       -> refuse (agent_disabled, tool_not_allowed, rate_limited)
       class <= auto_approve (default: passive)       -> allow ("policy")
       approved earlier in this session (TTL)         -> allow ("session")
       else ask (mcp_server.go:ask):
         client on protocol 2026-07-28  -> input request in the result; the client calls again with the answer
         client supports elicitation    -> form with the tool's ethics, egress and notifies_target
         neither (or the form failed)   -> error consent_required + summary + consent_token
                                           (HMAC over tool, artifact and arguments; single use; 10 min; this process)
     install: RequireSignature (signer recorded and cosign present); no local manifests, yanked or failed (broken warns);
              on an installed tool the question names both versions, a held one is refused (version_held), a native
              one too (trust_refused), and the same version answers already_installed
     run: the same runner and sandbox as `ot run`; output saved under <ot home>/results (or --results-dir)
     agent.Record -> <ot home>/agent-audit.jsonl (rotated at 10 MiB)
```

Unattended CLI runs take the same decision without asking anyone (`cli/consent.go:cliConsent`): when stdin isn't a
terminal (or `OT_NONINTERACTIVE=1`), `run`, `run --all`, `playbook` and `auto` refuse what the policy refuses (exit 4)
and stop on anything above passive with exit 2 `consent_required` unless `--yes` or `OT_CONSENT=off`; every such run
is audited with consent `policy`, `flag` or `off`.

The remote server is separate and runs nothing:

```
 MCP client --POST JSON-RPC--> api.otinstaller.com/mcp
   index.ts fetch: path /mcp -> remoteMcp -> mcp.ts:mcpEndpoint (initialize, tools/list, tools/call)
     tool -> get(path) -> edgeCached anonymous GET of /v1/tools, /v1/tools/:ns/:name, /v1/types, /v1/pivots,
             /v1/guides, guide pages (no caller headers) -> JSON result with the consent class ot mcp would give
```

### l. The community: issues, failed runs, requests, submissions and the upstream watcher

```
 person (site or ot)                          registry API (community.ts, inbox.ts)
   POST /tools/:ns/:name/issues  ---------->  poster(): timeout? daily limit? holdReason() (new account, screen(),
                                               first post with links) -> issues row visible | held
                                               announceIssue -> inbox rows for the namespace and tool_maintainers
   ot run fails at a terminal, "y"  ------->  POST /tools/:ns/:name/run-reports {version, exit_code, os, arch, ...}
                                               signed in: confirm(broken) + join or open the version's broken issue
                                               anonymous: run_signals daily count; 3 in a week -> system issue
   tool page: Report a problem (/report)
     signed in -------------------------->  POST /tools/:ns/:name/issues (as above; an error message is fenced in the body)
     signed out, broken or out of date -->  POST /tools/:ns/:name/problem-reports {kind, version?, platform?}
                                               problem_signals daily count, once per address (broken shares ot's key)
                                               broken: + run_signals, 3 in a week -> run_signals:<v> system issue
                                               outdated (latest only): 3 in a week -> outdated_signals:<v>, unless
                                               another outdated issue is open; announceVersion closes it
     malware, abuse, legal -------------->  POST /tools/:ns/:name/reports (private, reviewers)
   both report routes: an Origin other than SITE_URL -> 403 foreign_origin (ot sends none)
   */15 cron: deliverInbox("immediate"); nightly: deliverInbox("daily"), lockStaleThreads, refreshContributorStats
   PUT /tools/:ns/:name/follow {level} (all | releases | muted), PUT /me/follows/publisher|input/:target
     publishVersion (first time latest) -> notifyFollowers (releases; muted packages left out), and a security item
                                           when the version's scan warned
     setYanked, setDeprecated / clearDeprecated, applyMeta (archived), removeVersion, completeTransfer
                                        -> notifyPackageFollowers (lifecycle to level all; a malware takedown as security
                                           to all and releases)
   inbox rows -> /notifications (kinds the person keeps out of the inbox are left out of the list and the bell's count)
              -> deliverInbox -> the address of the sign-in account the person chose (email_prefs.email_provider)
   PUT /me/profile, PUT /me/handle (old handle -> handle_aliases, redirects) -> GET /people/:handle

 POST /requests {repo} --> readUpstream (as the requester, else the App on osintverse-community, else anonymous)
                            refuse: exists, packaged, upstream manifest; record declined: license, archived
                            -> tool_requests (+ the requester's vote and subscription); triagers: setRequestStatus -> inbox
 POST /requests/:n/comments --> addRequestComment: holdReason() like issue comments -> request_comments visible | held
                            -> inbox for request_subscriptions; edits, deletes, flags, moderation: community.ts
 publishVersion --> linkPublished: requests for the package's repository or its homepage's upstream -> published

 POST /imports {repo, community: true} --> detection --> POST /imports/:id/finish {mode: "submit", dockerfile?}
   submitWrapper: draftProblems, submissionChecks (license, manifest, packaged, submitted, PyPI source),
                  dockerfileChecks (conformant?) --> community bot (COMMUNITY_APP_*): createOrgRepo,
                  putFile x N, sources row --> createTag (pinned image/wheel) | dispatch otinstaller-release.yml
   tag webhook --> processJob --> record(): markSubmittedTool (needs_first_review, submitted_by)
   scan callback --> applyScanResults: awaiting_review (firstReleaseScanned -> in_review, reviewers notified)
   POST /submissions/:n/approve (reviewer, not the submitter) --> publishVersion --> firstReleasePublished
                  (needs_first_review = 0, tool_maintainers += submitter)

 nightly queueUpstreamChecks --> {upstreamCheckToolId} --> checkUpstream:
   repoState (gone, renamed, archived, license_changed) --> currentPin (override, pipx, Dockerfile at git_sha via
   findPin, upstream's own image) --> latestRelease (releases/latest with If-None-Match | PyPI | compare for commits)
   --> upstream_watch row; UPSTREAM_WATCH=issues: outdated issue 3 days after a release, closed when caught up;
   =prs: maybeOpenBump (pin-only PR for a stable release, superseded ones closed) --> POST
   /packages/:ns/:name/pulls/:n/release (maintainer) --> merge + release (wrapperVersion; status merged);
   =auto: also maybeAutoRelease (nightly only, a week after the release, tools.auto_release) --> the same release
   --> publishVersion / applyScanResults --> settleBump: released (outdated issue closed) | failed (maintainers told)
   --> every 15 min sweepBumps: rejected version or job, failed release workflow run, nothing in 12 h --> failed;
       a failed bump is released again (no merge, new version)

 nightly queueBuildChecks --> {buildCheckToolId} --> checkBuild (Docker packages with a source in osintverse-community):
   checkDependencies (community_packaged = 0): requirements.txt at git_sha (only when the version changed) -->
   parseRequirements --> PyPI JSON per pin --> dependency_watch rows; UPSTREAM_WATCH=issues: dependency:<pkg>==<ver>
   issues; =prs: maybeOpenDependencyBump (one otinstaller/deps-<hash> PR, bump_prs kind dependency); =auto:
   maybeAutoReleaseDependencies --> releaseBump (nextPatch) --> the same settle and sweep as bumps
   checkBaseImage: Dockerfile's last FROM (baseImage) --> dockerHubRef --> hubDigest (auth.docker.io token + HEAD
   manifest, cached in base_images for 20 h) --> base_watch (built_digest when the version is first seen; updated
   when it differs); REBUILD_WATCH=rebuild: maybeRebuild (vuln scan warn, main at git_sha, tools.auto_release, 14 days,
   5 a day) --> bump_prs kind rebuild (#0, merged) --> dispatch otinstaller-release.yml --> settleBump / sweepBumps

 GET /packages/:ns/:name/files (maintainer: main's otinstaller.yaml, Dockerfile, README.md via the community bot)
   --> POST /packages/:ns/:name/proposals {title, note, files}: createProposal --> checkProposal (only what changed;
       validate, protected_field, version past every version, dockerfileChecks, screen) --> community bot:
       openPullRequest otinstaller/proposal-<id> --> updatePull (links the page) --> change_proposals row, inbox
   --> POST .../proposals/:n/review (reviewer, not the proposer): changes_requested (proposer PATCHes: branch rebuilt)
       | reject (closePull) | approve: mergePull --> dispatch otinstaller-release.yml (builds) | createTag v<version>
   --> tag webhook --> processJob --> scan --> published like any release

 GET /tools/:ns/:name/status | /versions | /activity --> first-week.ts: versions published under 7 days ago carry
   their confirmations since (works, broken); the status line says when it came out; ot outdated adds a note
```

