# Troubleshooting

Recipes for the problems that come up in production and local development, grounded in the code. The flows they refer
to are in [architecture.md](architecture.md); tables and columns are in [database.md](database.md); admin endpoints
are in [api.md](api.md).

Anything that writes to production (SQL `UPDATE`s, `wrangler secret put`, deploys) needs the owner's go-ahead first.

Conventions:

- Reads against production: `cd api && npx wrangler d1 execute otinstaller --remote --command "SELECT ..."`. Use
  `--file query.sql` for anything multi-line or with quotes (PowerShell and Git Bash quoting is painful with
  `--command`; `--file` also takes several statements). Every remote read counts against D1's read allowance, so add
  `LIMIT`.
- Writes to production (`UPDATE ...`) change production: do them only when the owner asks.
- Live logs: `npx wrangler tail otinstaller-registry-api --format pretty` (add `--status error`, or
  `--search "queued work failed"`); the mirror is `npx wrangler tail otinstaller-mirror`. `console.error` lines from
  the queue consumer, cron and `onError` (`request <id>: ...`) appear there; `onError` also sends to Sentry via
  `ops.ts:reportError` when `SENTRY_DSN` is set, tagged with `request_id` (the `cf-ray`).
- Admin calls: `curl -H "Authorization: Bearer ot_..." https://api.otinstaller.com/v1/admin/...` with a reviewer or
  admin user's token.
- Timestamps are Unix milliseconds: `datetime(created_at/1000, 'unixepoch')`.

### Stuck publish jobs

What happens automatically: every 15 minutes `ops.ts:alertStuckJobs` emails admins about up to 50 jobs in
`queued`, `validating` or `scanning` older than 30 minutes (one email per distinct set of job IDs, via the
idempotency key `stuck:<ids>`). Jobs in `awaiting_review` or `error` are not included. A `scanning` version whose scan
never reports back is closed after 1 hour by `expireStaleScans` (next recipe).

Find them:

```sql
SELECT j.id, j.provider, j.repo, j.tag, j.status, j.attempts, j.error_code, j.version_id,
       v.status AS v_status, v.scan_dispatched_at, v.scan_token_expires_at,
       datetime(j.created_at/1000,'unixepoch') AS created,
       datetime(j.updated_at/1000,'unixepoch') AS updated
FROM publish_jobs j LEFT JOIN versions v ON v.id = j.version_id
WHERE j.status IN ('queued','validating','scanning') ORDER BY j.created_at LIMIT 50;
```

Read the state:

- `queued`, `attempts = 0`: the message never ran. Check the queue's backlog in the Cloudflare dashboard and
  `wrangler tail` for consumer errors.
- `validating`, `attempts >= 1`: `processJob` started and died or keeps retrying. Look for `queued work failed` or
  the host error in tail. Transient errors retry 5 times (30, 60, ... s); after that `failJob` sets `error`
  (`error_code = 'internal_error'`, `error_detail` = the message). A job left in `validating` without retries means
  the Worker invocation was killed (CPU or subrequest limits) after the status update.
- `scanning` with `scan_dispatched_at IS NULL`: the dispatch to registry-ops failed (check `OPS_REPO`,
  `OPS_DISPATCH_TOKEN` or `OPS_INSTALLATION_ID`, and GitHub's answer in tail: `otinstaller-scan dispatch failed:
  <status>`). After 5 attempts `failJob` rejects the version and sets the commit status to error.
- `scanning` with `scan_dispatched_at` set: waiting for the scanner; see "Scans that never call back".

Requeue: there is no admin requeue endpoint. Options, in order of preference:

1. Ask the author to push the tag again (delete and re-push it). For GitHub this is a new `create` delivery, so
   `onTag` inserts a new job; for GitLab `queueTag` runs again. Both still need the old version row out of the way:
   `releaseProblems` reports `manifest_version_exists` for any non-rejected row.
2. Close the stuck job and its version, then trigger a sync (`ot sync <ns>/<name>` → `POST
   /v1/packages/:ns/:name/sync`, at most `MANUAL_SYNC_PER_HOUR` an hour; only works once the package has a `sources`
   row):

   ```sql
   UPDATE publish_jobs SET status = 'error', error_code = 'internal_error',
     error_detail = 'closed by hand to requeue', updated_at = <now ms> WHERE id = '<job id>';
   UPDATE versions SET status = 'rejected', rejected_reason = 'internal_error'
     WHERE id = '<version id>' AND status IN ('scanning');
   UPDATE sources SET etag = NULL WHERE tool_id = '<tool id>';   -- or pollSource may see "not modified"
   ```

   `queueTag` skips tags that have a job not in `error`, or a version not `rejected`; `pollSource` only queues tags
   when the tag list changed since `sources.etag`, so clearing it makes the next poll re-read the list.
3. Redelivering the GitHub webhook from the App settings does not help if the first delivery created the job: the
   redelivery has the same `x-github-delivery`, and `onTag` answers "duplicate delivery". It does help if the first
   delivery failed before the insert.

Publishers see the outcome on the commit status (its link opens `/dashboard/publish/<jobId>`) and in the dashboard
(`GET /v1/me/publish-jobs`, last 50, GitHub and GitLab jobs). Staff see failed jobs from the last 7 days in
`GET /v1/admin/beta-metrics` (`failed_publishes_7d`), the admin console's Beta tab.

### Scans that never call back

Automatic: `scans.ts:expireStaleScans` (every 15 minutes) rejects versions in `scanning` whose
`scan_token_expires_at` (dispatch + 1 h) has passed: `versions.status = 'rejected'`, `rejected_reason =
'scan_timeout'`; `publish_jobs.status = 'error'`, `error_code = 'scan_timeout'`, `error_detail` "the security scan
did not report back within an hour; push the tag again". Guides' content checks use the same columns.

Check:

```sql
SELECT v.id, n.name || '/' || t.name AS ref, v.version, v.status, v.rejected_reason,
       datetime(v.scan_dispatched_at/1000,'unixepoch') AS dispatched,
       datetime(v.scan_token_expires_at/1000,'unixepoch') AS expires
FROM versions v JOIN tools t ON t.id = v.tool_id JOIN namespaces n ON n.id = t.namespace_id
WHERE v.status = 'scanning' OR v.rejected_reason = 'scan_timeout'
ORDER BY v.created_at DESC LIMIT 20;
```

Then look at the `scan` workflow runs in `OTInstaller/registry-ops` (Actions tab, filter by
`repository_dispatch`). The run log has `scanning <ref>`, `summary: {...}` and `registry answered <status>: ...`.
Common causes: the workflow file in registry-ops is out of date with `ops/workflows/scan.yml`; the run took longer
than an hour (the callback then gets 401 `invalid_scan_token`); the callback URL (`API_URL` + `/v1/internal/scans`)
was unreachable; malformed results (400 `invalid_scan_results`).

`expireStaleScans` does not change the commit status or send an email, so the author still sees "Valid; security
scans running" on GitHub/GitLab. Tell them to push the tag again. To reproduce a scan locally, take the
`client_payload` (see `scans.ts:dispatchScan`) and run `python ops/scanner/scan.py request.json` without `--post`
(prints the results), or in the scanner image as in `docs/publishing-setup.md` section 4.

### Failed scans and what the publisher sees

Verdict codes (`scans.ts:verdict`): `signature_mismatch`, `signature_dropped`, `malware_suspected`,
`secrets_found`, `smoke_test_failed`. The publisher gets:

- commit status `failure` "<code>: <message>" (target `<SITE_URL>/dashboard/publish/<jobId>`);
- email "<ref> <version> was not published" with the code, message and `https://otinstaller.com/docs/errors#<code>`
  (`templates.rejected`, key `rejected:<versionId>`);
- `publish_jobs.error_code` / `error_detail` in `GET /v1/me/publish-jobs`.

Rejected versions are not served by the public `/scans` route (`findVersion` only returns published, yanked or
removed). Staff can read the details:

```sql
SELECT s.kind, s.result, s.summary_json FROM scans s
WHERE s.version_id = '<version id>' ORDER BY s.ran_at;
```

`smoke.summary_json` holds `exit_code`, `network` and the last 1000 characters of output. Typical fixes:
`smoke_test_failed` on a tool that needs a key or network: declare `test.expect_exit_code`, or `network.egress: true`
(the smoke test is offline unless `egress` is exactly true); `signature_mismatch`: the image was signed by a workflow
other than the repository's own CI (`expected_signer_regexp` on the version row); `signature_dropped`: sign with the
release template. Fixable high/critical CVEs only warn (`scan_status = 'warn'`, the published email mentions it).

### Backup runs that expire or fail (`too_large`)

```sql
SELECT r.id, r.trigger, r.status, r.error, datetime(r.created_at/1000,'unixepoch') AS created,
       datetime(r.expires_at/1000,'unixepoch') AS expires
FROM backup_runs r ORDER BY r.created_at DESC LIMIT 20;

SELECT b.kind, b.status, b.location, b.size_bytes, b.detail, b.visibility, b.delete_after
FROM backups b JOIN tools t ON t.id = b.tool_id JOIN namespaces n ON n.id = t.namespace_id
WHERE n.name = '<ns>' AND t.name = '<name>' ORDER BY b.created_at DESC LIMIT 20;
```

- `backup_runs.status = 'failed'` with `error`: the dispatch failed (same token/repo checks as scans).
- `expired` (item detail "the backup job did not report back"): the registry-ops run failed or never posted to
  `complete_url` within 3 h (release) / 12 h (weekly). Check the `scan` workflow run for the backup.
- `failed` "the upload did not arrive": the PUT to the signed URL failed. Without the `R2_*` secrets, uploads go
  through the Worker and anything over 100 MB fails: set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`.
- `failed` "the image is not in the mirror": crane copy did not finish; check `MIRROR_PUSH_TOKEN` in registry-ops and
  on the mirror Worker, and `curl -i https://mirror.otinstaller.com/v2/` (expects 401 with a Bearer challenge).
- `too_large`: over 500 MB (bundle), 2 GB (image) or 1 GB (wheel). Owners get one email per run
  (`templates.backupTooLarge`). Other items in the run are still kept. `backfillBackups` does not retry `too_large`.

Automatic retries: `backfillBackups` retries image and wheel backups of published versions at most once a day each,
5 versions per 15 minutes. Git bundles are not backfilled; the next Monday's `weeklyBackups` makes a new one.
By hand: `POST /v1/admin/tools/:ns/:name/:version/backup` (dispatch now), or with `{"dispatch": false}` to get the job
and run `MIRROR_PUSH_TOKEN=... python ops/scanner/scan.py job.json` yourself.

### Restore drill failures

Admins are emailed for every drill that does not `pass` (`templates.drillFailed`): a failed dispatch, a reported
failure, or no report within 6 h (`expireDrills`). Read the details with `GET /v1/admin/backups/drills` (last 20,
with the bundle and image locations) or:

```sql
SELECT id, status, detail, datetime(created_at/1000,'unixepoch') AS created FROM restore_drills
ORDER BY created_at DESC LIMIT 5;
```

`detail` holds the scanner's `detail` plus its `checks` JSON. Run another with `POST /v1/admin/backups/drill`
(answers `nothing_to_drill` when there is no stored bundle or public mirrored image yet).

### Edge-cache staleness

Symptoms: a change (publish, yank, removal, review decision) is not visible to anonymous clients or the site's SSR
pages, while signed-in views show it. Check with `curl -sI <url>`: `x-edge-cache: hit` means the answer came from
`caches.default`. Worst-case staleness is the endpoint's `max-age` (table in flow i): 60 s for search and tool
pages, 1 h for an exact version's manifest, 1 h for the wheel route. Removals and yanks don't wait: they move the
cache epoch on (`settings.cache_epoch`), and within 30 seconds nothing cached before them is served.

There is no purge by URL in code. Workarounds:

- To drop everything cached at once, move the epoch on as a takedown does:
  `UPDATE settings SET value = lower(hex(randomblob(4))), updated_at = unixepoch() * 1000 WHERE key = 'cache_epoch';`
  (a production write: the owner's go-ahead first).
- Wait out the `max-age`.
- To see the origin's answer, send any `Authorization` or `Cookie` header: `edgeCached` skips the cache when either
  header is present, even an invalid one (`curl -H "Authorization: Bearer x" ...`).
- A different query string is a different cache key (all params are part of it).
- Zone-level purge in the Cloudflare dashboard should also clear Cache API entries for `api.otinstaller.com`;
  a purge by URL must match the stored key, which includes the sorted query and an added `__cors=any` or
  `__cors=site` parameter. This is not exercised anywhere in the repo, so check it on one URL first.
- Locally and in tests set `EDGE_CACHE=off` (`vitest.config.ts` does).

When adding an endpoint, choose `cached(c, seconds)` as "how stale may production be"; anything per-user or
just-changed must be `private, no-store`.

### D1 read-limit exhaustion

Symptoms (21 October 2026): every API read answered 500 `internal_error`
(with `request_id`), the site showed its 500 page (with the request ID) or 404s, for
hours. Cause: crawlers walking every combination of search filters on the site; each uncached `/v1/tools` without
`q` reads up to 1000 joined rows and ranks them in the Worker (`index.ts` `GET /tools`).

Mitigations now in place: `edge-cache.ts` for anonymous GETs; `rel="nofollow"` on filter/sort/pagination links;
`noindex` on any URL with a query string (the site's `Base.astro`); `robots.txt` `Disallow: /*?`; the account moved to Workers
Paid. Remaining exposure: the cache key includes every query parameter, so new filter combinations still miss; every
signed-in request goes to D1; `caches.default` is per data centre. Watch D1 reads in the Cloudflare dashboard; tail
for `D1_ERROR` lines.

A D1 failure on Cloudflare's side answers 503 `database_unavailable` with `Retry-After`
instead of 500 (a daily limit says to wait until midnight UTC), and Sentry gets it as a warning in one issue per
kind (fingerprint `d1-unavailable` + `transient` or `daily-limit`), not a new error issue for each route. The site
retries such a read once after a second. A burst of `D1_ERROR: internal error; reference = ...` warnings (Sentry
OTINSTALLER-A and -B, 21 to 23 Oct: twelve in three bursts, all read-only queries D1 had already retried twice) is
Cloudflare's to explain; quote the references to Cloudflare support if it keeps happening.

### CORS errors from localhost

Expected: `index.ts` gives credentials only to `Origin == SITE_URL`; `http://localhost:4321` gets
`Access-Control-Allow-Origin: *` without credentials, so islands that call `/me` etc. with
`credentials: "include"` fail against production. Public SSR reads still work (no browser CORS). For a full local
check run the API with `cd api && npm run dev -- --var SITE_URL:http://127.0.0.1:<site port>` (seeded local D1) and
build the site with `PUBLIC_API_URL=http://127.0.0.1:8787`.

### Emails not sending

`notify.ts:sendEmail` first claims the idempotency key in `notifications`, then calls Resend:

- no `RESEND_API_KEY`: rows are inserted with `status = 'skipped'`;
- with a key, rows are inserted as `failed` with `error = 'not sent yet'` and the text kept in `body`; Resend accepting
  it makes the row `sent` (and drops the text); a non-2xx or a fetch that throws leaves it `failed` with the error.
- Every 15 minutes `retryEmails` sends failed rows again (same idempotency key, so never twice), five tries in all
  over two days; a 4xx other than 429 is not retried. After that the text is dropped.

```sql
SELECT kind, status, COUNT(*) AS n FROM notifications
WHERE created_at > (strftime('%s','now') - 86400) * 1000 GROUP BY kind, status;
SELECT datetime(created_at/1000,'unixepoch') AS at, kind, to_email, subject, error
FROM notifications
WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;
```

Test the key: `POST /v1/admin/email-test` (admin) mails the caller and answers `{status, to, error?}` (502 with
Resend's error on failure). After 21 Oct the cause was a deleted Resend key (`401 API key is invalid`); fix with
`npx wrangler secret put RESEND_API_KEY`. Failed messages are never re-sent: their key is already claimed, so a retry
returns `duplicate`. Recipients come from `ownerEmails` / `staffEmails` (`users.email`, falling back to a linked
account's email); a namespace with no owner who has an email gets no mail (`sendEmail` returns `skipped` without a
row).

### GitLab webhook and token problems

- Webhook 401 `bad_signature`: no source for `project_id`, no `webhook_secret_hash`, or the hook's token differs
  (each project has its own). Reconnect the project (`POST /v1/sources/gitlab {"project": "group/name"}` →
  `routes/sources.ts:connectGitlabProject`), which creates a new hook and secret and sets `sync_status = 'ok'`.
- 403 `gitlab_scope_required` when connecting or finishing an import: sign in again at
  `/v1/auth/gitlab/login?scope=api`; the GitLab application itself must have `api` ticked
  (`docs/publishing-setup.md` section 3).
- Webhook answers 200 "ignored: sync paused": `sources.sync_status = 'paused'`, set by `pollSource` when GitLab
  answers 401/403 (token revoked, or `gitlabToken` refresh failed) and by `DELETE /v1/sources/:id`. Owners got a
  "Sync paused" email. Reconnect.
- Jobs fail early: `jobContext` throws "job ... has no connected GitLab project", or `gitlabToken` fails to
  refresh (`refreshing the GitLab token`); everything runs as `sources.connected_by`, so that user's linked GitLab
  account must still be valid.
- Check recent events: `GET /v1/packages/:ns/:name/sync-log` (or `ot sync` / `sync_events`).
- Pipeline side (`spec/templates/gitlab-*.yml`): the job token needs "Allow Git push requests to the repository";
  `RELEASE_TOKEN` is the alternative.

### cosign verify failures in `ot` (exit 4)

`runner/install.go:installDocker` prints cosign's stderr and fails with `signature verification failed for <image>;
refusing to install` (`TrustError`, exit 4). Reproduce by hand with the values the registry returned:

```
curl -s https://api.otinstaller.com/v1/tools/<ns>/<name>/<version>/manifest
# -> signer_identity, signer_issuer
cosign verify --certificate-identity '<signer_identity>' \
  --certificate-oidc-issuer '<signer_issuer>' <image@digest>
```

Causes: no network to the Sigstore services; an old cosign; the image pulled from the mirror without its
`sha256-<hex>.sig` tag (check the image backup row; `backup.py:copy_signature_tags`); a different signer than at
publish time. A missing cosign only warns. Other exit-4 refusals on install: "is not pinned by digest", wheel hash
mismatch ("downloaded wheel hash ... does not match"), "no wheel for ... matches the manifest's sha256", removed
packages, and invalid manifests.

### Mirror fallback not triggering

All of these must hold (`installDocker`):

1. The manifest response has `mirror_image`: a `backups` row with `kind = 'image'`, `status = 'stored'`,
   `visibility = 'public'` (OSI-approved license), `delete_after IS NULL`. Check with the manifest `curl` above; note
   it may be an edge-cached answer from before the backup was stored (up to 1 h for an exact version).
2. Same digest in `mirror_image` and `runtime.image` (`sameDigest`).
3. The pull output matches the `unavailable` regexp (401/403/404, denied, unauthorized, not found, manifest unknown,
   name unknown, error from registry). DNS failures, refused connections and timeouts never fall back, by design.

For pipx the equivalent is `wheel_url` plus `gone(err)` (PyPI 403/404/410, or no file with the hash). The mirror
itself returns 404 for hidden (taken-down) images to anonymous callers. `scripts/e2e-backups.sh` exercises both
fallbacks end to end.

### `ot doctor`

Output (`cli/internal/cli/run.go:doctorCmd`), one line per check, then the data directory:

```
[ok  ] containers   docker is running
[ok  ] pipx         found
[ok  ] python       found
[ok  ] cosign       found; image signatures are verified
[ok  ] keychain     readable and writable
[ok  ] registry     https://api.otinstaller.com/v1 reachable

Data directory: C:\Users\<you>\AppData\Roaming\ot
```

- `containers` FAIL: Docker/Podman not on PATH (`DetectEngine` tries docker then podman), or `<engine> info` failed
  ("installed but not running; start Docker Desktop").
- `pipx` / `python` pass whenever an engine is present (they only matter for `--native`).
- `cosign` is never a failure; "not found" means signatures are skipped locally.
- `keychain` writes and deletes `OT_DOCTOR_CHECK`.
- `registry` runs one search (`limit=1`); a failure shows the error (check `OT_API_URL`).
- Any FAIL exits 5 (`ExitRuntimeMissing`).

### Self-update and install script failures

- `ot self-update` "this build of ot has no release key" (exit 2): a build without `-X ...selfupdate.PublicKey`
  (e.g. `go build`); reinstall from the install script.
- "update refused: ..." (exit 4): `checksums.txt.sig` did not verify, or the archive hash differs.
- "cannot find the latest release": `api.github.com` refused (unauthenticated rate limit) or no release on
  `otinstaller/ot`.
- On Windows a leftover `ot.exe.old` next to the binary is normal (`Replace` renames the running exe first).
- `get.otinstaller.com` returning a script that prints "could not download ... (GitHub answered <status>)": the
  latest release lacks `install.sh`/`install.ps1` (the release workflow writes them to `dist/install/`). The Worker
  caches the script 5 minutes. The script warns "only the checksum is checked" when the key placeholder was not
  filled in or no OpenSSL 3 is available (macOS LibreSSL).
- `get.otinstaller.com/otlite` serves `otlite/scripts/install.sh` from `main` on GitHub, so a broken installer is
  fixed by merging the fix; the 5-minute cache still applies.

### Agents and unattended runs

- `consent_required` (exit 2) from `ot run`, `--all`, `playbook` or `auto` in a script or CI: the tool isn't passive
  and there is no terminal. Pass `--yes` once the person has agreed, or set `OT_CONSENT=off`; both are written to
  `<ot home>/agent-audit.jsonl`.
- `consent_required` from `ot mcp`: the client can't show a consent form. The error carries a summary and a
  `consent_token`, valid once, for that exact call, for 10 minutes and only in the same server process; a restarted
  server (or a changed argument) needs a new answer.
- An agent run refused outright: check `ot mcp policy` (`enabled`, `allow_tools`/`deny_tools`, the run limits) and
  `ot mcp audit --since 24h`. A broken `agent-policy.json` is an error, never ignored; `ot mcp policy reset` writes the
  defaults.
- `ot mcp` won't install an image another `ot` would: under `ot mcp`, a Docker image needs a recorded signer and
  cosign on the PATH.
- 403 `insufficient_scope` from the API: the token lacks the scope in `required_scope`. Make one with it
  (`ot token create <name> --scope <scope>`, or `ot login --scope ...`); `staff` tokens come only from the website.
