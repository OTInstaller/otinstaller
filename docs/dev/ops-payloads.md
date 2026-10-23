# Ops payloads: the API and the registry-ops jobs

Reference for the contracts between the registry API (`api/`) and the jobs run in the private repo
`OTInstaller/registry-ops` (copied from `ops/`). Derived from:

- `api/src/scans.ts` (`dispatchOps`, `dispatchScan`, `verdict`, `applyScanResults`, `expireStaleScans`)
- `api/src/backups.ts` (`releasePlan`, `createRun`, `dispatchBackups`, `completeRun`, `startDrill`, `completeDrill`)
- `api/src/routes/review.ts` (`POST /internal/scans`, `parseResults`)
- `api/src/routes/backups.ts` (`POST /internal/backups/:run`, `POST /internal/drills/:id`, signed object URLs)
- `api/src/routes/ops.ts`, `api/src/ops.ts` (health endpoints, `healthTargets`, `applyHealth`)
- `api/src/lib/presign.ts` (signed URLs)
- `ops/scanner/scan.py`, `backup.py`, `health.py`, `ops/scanner/Dockerfile`
- `ops/workflows/scan.yml`, `ops/workflows/health.yml`

If you change either side of a contract, change the other in the same commit, and remember the copies in
registry-ops have to be updated separately.

---

## 1. Overview

| Flow | Direction | Transport | Auth |
| --- | --- | --- | --- |
| Scan request | API → registry-ops | `repository_dispatch` `otinstaller-scan` | GitHub token (see 2.1) |
| Scan result | scanner → API | `POST /v1/internal/scans` | single-use `callback_token` (Bearer) |
| Backup plan (inline) | API → scanner | the JSON answer to the scan callback | – |
| Backup request | API → registry-ops | `repository_dispatch` `otinstaller-backup` | GitHub token |
| Backup uploads | scanner → R2 or API | `PUT` to signed URLs | signature in the URL |
| Backup report | scanner → API | `POST /v1/internal/backups/:run` | single-use run `token` (Bearer) |
| Image copy | scanner → mirror | OCI push with `crane` | `MIRROR_PUSH_TOKEN` |
| Restore drill | API → registry-ops | `repository_dispatch` `otinstaller-drill` | GitHub token |
| Drill report | scanner → API | `POST /v1/internal/drills/:id` | single-use drill `token` (Bearer) |
| Health targets | health job → API | `GET /v1/internal/health/targets` | static `HEALTH_TOKEN` (Bearer) |
| Health results | health job → API | `POST /v1/internal/health` | static `HEALTH_TOKEN` (Bearer) |

Only one workflow (`scan.yml`) handles all three dispatch types; `health.yml` is cron-driven and pulls its work.

---

## 2. Dispatch (`dispatchOps`)

```ts
dispatchOps(env, eventType, clientPayload)
// POST https://api.github.com/repos/${OPS_REPO}/dispatches
// { "event_type": eventType, "client_payload": clientPayload }
```

### 2.1 Token used

1. `OPS_DISPATCH_TOKEN` (trimmed) if set: a fine-grained token with Contents: write on `OPS_REPO` only.
2. Otherwise a GitHub App installation token built from `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
   `OPS_INSTALLATION_ID` (all via `requireSecret`, so a missing one throws 503 `not_configured`).

`OPS_REPO` is always required (`requireSecret`; set as a var in `wrangler.jsonc` to `OTInstaller/registry-ops`).

Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`,
`User-Agent: otinstaller-registry`.

### 2.2 Failure

A non-2xx answer throws `github.HostError("<type> dispatch failed: <status> <first 200 chars>")`, marked transient
when the status is ≥ 500 or 429 (the queue retries transient errors, up to 5 attempts).

### 2.3 Event types

| `event_type` | `client_payload` | Sent by |
| --- | --- | --- |
| `otinstaller-scan` | `{ "scan": {...} }` | `dispatchScan` (publish pipeline, tools only; guides get content checks in the Worker) |
| `otinstaller-backup` | `{ "backup": { "jobs": [BackupPlan, ...] } }` | `dispatchBackups` (queue `backupVersionId`, 15-minute backfill, weekly git backups, admin "back up now") |
| `otinstaller-drill` | `{ "drill": {...} }` | `startDrill` (monthly cron `23 5 1 * *`, or `POST /v1/admin/backups/drill`) |

GitHub allows at most 10 top-level keys in `client_payload`, which is why each payload is wrapped in one key.

---

## 3. Scans

### 3.1 Before dispatch

`dispatchScan` generates a 32-byte random token and stores on the `versions` row:

- `scan_token_hash` = SHA-256 of the token
- `scan_token_expires_at` = now + `SCAN_TOKEN_TTL` (1 hour)
- `expected_signer_regexp`, `expected_signer_issuer` (from `expectedSigner`)

After a successful dispatch it sets `scan_dispatched_at`. A failed dispatch leaves it null and the queue retries
(`processJob` re-dispatches jobs in `scanning` with `scan_dispatched_at IS NULL`).

### 3.2 `client_payload.scan`

```json
{
  "scan": {
    "version_id": "01J...ULID",
    "ref": "osintverse-community/dns-lookup@1.2.0",
    "source_repo": "github.com/osintverse-community/dns-lookup",
    "upstream_repo": "github.com/upstream/project",
    "kind": "tool",
    "runtime": {
      "kind": "docker",
      "image": "ghcr.io/osintverse-community/dns-lookup@sha256:<64 hex>",
      "platforms": ["linux/amd64", "linux/arm64"],
      "command": ["dns-lookup", "--domain", "{domain}"],
      "output_format": "json",
      "timeout_seconds": 300
    },
    "test_input": { "domain": "example.com" },
    "expect_exit_code": 0,
    "network_egress": false,
    "expected_signer": {
      "identityRegexp": "^https://github\\.com/osintverse-community/dns-lookup/\\.github/workflows/[^@]+@refs/(tags/v1\\.2\\.0|heads/[^@]+)$",
      "issuer": "https://token.actions.githubusercontent.com"
    },
    "callback_url": "https://api.otinstaller.com/v1/internal/scans",
    "callback_token": "<single-use token>"
  }
}
```

| Field | Meaning |
| --- | --- |
| `version_id` | The `versions` row being scanned. Also used by `scan.yml`'s concurrency group. |
| `ref` | `<namespace>/<name>@<version>`, for logs and the scanner's image tag (`ot-scan/<slug>:latest` for pipx). |
| `source_repo` | `<provider>.com/<repo>` (`github.com/...` or `gitlab.com/...`). Used for PyPI provenance matching. Empty for a direct upload (`ot publish`), which has no repository. |
| `upstream_repo` | Only present for community wrappers: the upstream project whose own PyPI provenance is also accepted. |
| `kind` | `m.kind ?? "tool"`. The scanner returns empty results for `guide` or a missing runtime. |
| `runtime` | The manifest's `runtime` object verbatim, or `null`. Docker: `image` (digest-pinned), `command`, ... pipx: `package`, `package_version`, `entrypoint`, `wheel_sha256`, `command`, ... |
| `test_input` | `m.test.input` or `null`. `null` means the smoke test is skipped. |
| `expect_exit_code` | `m.test.expect_exit_code ?? 0`. Smoke passes when the exit code equals this (tools that need a key can declare the code they give without one; the scan has no secrets). |
| `network_egress` | `true` only when `m.network.egress === true`; the smoke container then gets `--network bridge`, otherwise `none`. |
| `expected_signer` | `identityRegexp` + `issuer` that a valid cosign signature must match (see 3.3). `null` for a direct upload: any keyless signature counts, and the API holds the package to its first signer (3.6). |
| `callback_url` | `${API_URL}/v1/internal/scans`. |
| `callback_token` | The plaintext single-use token; only its hash is stored. |

### 3.3 Expected signer (`expectedSigner`)

The repo and tag are regex-escaped. The ref part accepts the tag or any branch (the release templates sign on the
default branch before tagging): `@refs/(tags/<tag>|heads/[^@]+)$`.

| Provider | `identityRegexp` | `issuer` |
| --- | --- | --- |
| github | `^https://github\.com/<repo>/\.github/workflows/[^@]+@refs/(tags/<tag>\|heads/[^@]+)$` | `https://token.actions.githubusercontent.com` |
| gitlab | `^https://gitlab\.com/<repo>//[^@]+@refs/(tags/<tag>\|heads/[^@]+)$` | `https://gitlab.com` |

### 3.4 What `scan.py` does with it

Entry: `python3 ops/scanner/scan.py <request.json> [--post]`. `main()`:

1. Loads the file; if it has a top-level `job` key (the admin "back up now" response), uses that.
2. `backup` key → `backup.run_backup_request(payload["backup"])`; `drill` key → `backup.drill(payload["drill"])`.
3. Otherwise `req = payload.get("scan", payload)` (accepts the whole `client_payload` or the bare scan object).
4. Runs `scan(req)`; without `--post` prints the results JSON and exits 0; with `--post` posts them to
   `callback_url`, and if the answer contains `backup`, runs `backup.run_job(answer["backup"], work)` with the same
   temp directory (so the verified wheel is reused).

Per runtime:

- **Guide or no runtime**: returns `empty_results()` (signature `absent`, vulnerabilities `null`, counts 0, smoke
  `skipped`) plus `scanner_version`.
- **docker**: `docker pull <image>` (exception if it fails), `cosign verify --output json
  --certificate-identity-regexp ... --certificate-oidc-issuer ...`. On success it reads the verified identities from
  that JSON (`optional.Subject` / `optional.Issuer`; `verified_identities`), falling back to `cosign download
  signature` and the certificate (via `cryptography`), to report `identity` and `issuer`. If strict verify fails, a
  loose verify (`.*` identity and issuer) tells "signed by someone else" (`fail`, detail lists the identities) from
  "unsigned" (`absent`). With `expected_signer: null` (`check_any_signature`) only the loose verify runs: `pass` with
  `identities: [{identity, issuer}]` (every distinct verified signer, at most 20), else `absent`. Then `trivy image --scanners vuln,secret --format json` and `trivy image --format cyclonedx` (SBOM
  package count). Malware is always `{count: 0, note: "not applicable to images"}`. Then the smoke test.
- **pipx**: fetches `https://pypi.org/pypi/<package>/<package_version>/json`, picks the `bdist_wheel` whose sha256
  equals `wheel_sha256` (none → signature `fail` "no wheel matches the manifest's sha256"), downloads it and re-hashes
  (mismatch → signature `fail`). Provenance: `https://pypi.org/integrity/<pkg>/<ver>/<file>/provenance` (PEP 740);
  pass when an attestation publisher's repository equals `source_repo` or `upstream_repo` (host prefix stripped,
  lowercase); none → `absent`; others → `fail`. With neither (a direct upload) any publisher passes, reported as
  `identities` (`pypi:<kind>:<repo>/<workflow>`, issuer `https://pypi.org`). Builds a `python:3.12-slim` image with the wheel installed
  (uid 10001) and runs Trivy on it with `--pkg-types library`. GuardDog (`guarddog pypi scan <wheel>
  --output-format json`) restricted to code-behaviour rules: code-execution, cmd-overwrite, download-executable,
  exec-base64, exfiltrate-sensitive-data, obfuscation, silent-process-execution, steganography, dll-hijacking,
  clipboard-access. If GuardDog is not installed, malware count is 0 with a note.
- **Smoke test** (`smoke`): builds the command from `runtime.command`, substituting `{name}` from `test_input`;
  an argument whose placeholder has no value is dropped, together with a preceding `-flag`. Runs:
  `docker run --rm --network <bridge|none> --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL
  --security-opt no-new-privileges --pids-limit 256 --memory 1g --user 65534:65534 -e HOME=/tmp --entrypoint <cmd[0]>
  <image> <cmd[1:]>` with a 120 s timeout (`SMOKE_TIMEOUT`; a timeout counts as exit 124). Status `pass` when the
  exit code equals `expect_exit_code`, else `fail`. Output excerpt is the last 1000 chars.

An unhandled exception (image cannot be pulled, Trivy fails, wheel image build fails, package not on PyPI) ends the
script without posting. The version then stays `scanning` until `expireStaleScans` (every 15 minutes) rejects it with
`scan_timeout` after the token's 1-hour expiry ("push the tag again").

### 3.5 Callback: `POST /v1/internal/scans`

Request (from `scan.post`):

```
POST /v1/internal/scans
Authorization: Bearer <callback_token>
Content-Type: application/json
User-Agent: otinstaller-scanner
```

Body (`ScanResults`):

```json
{
  "scanner_version": "0.1.0",
  "signature": {
    "status": "pass",
    "identity": "https://github.com/osintverse-community/dns-lookup/.github/workflows/otinstaller-release.yml@refs/heads/main",
    "issuer": "https://token.actions.githubusercontent.com",
    "detail": "optional explanation"
  },
  "vulnerabilities": { "critical": 0, "high": 1, "medium": 4, "low": 9, "fixable_critical": 0, "fixable_high": 1 },
  "secrets": { "count": 0, "findings": [{ "rule": "aws-access-key-id", "target": "/app/x", "line": 3 }] },
  "malware": { "count": 0, "findings": [{ "rule": "exec-base64", "detail": "..." }], "note": "optional" },
  "smoke": { "status": "pass", "exit_code": 0, "network": "none", "duration_ms": 2140, "output_excerpt": "...",
             "sample": { "output_format": "json", "entities": [{ "type": "domain", "value": "example.com" }], "entity_count": 3 } },
  "sbom": { "packages": 132 }
}
```

| Field | Values | Notes |
| --- | --- | --- |
| `signature.status` | `pass` \| `fail` \| `absent` | `identity`/`issuer` stored on the version only when `pass`. For pipx, identity is `pypi:<kind>:<repo>/<workflow>` and issuer `https://pypi.org`. |
| `signature.identities` | optional, at most 20 `{identity, issuer}` strings | Sent when there was no expected signer (a direct upload): every signer that verified. The API picks the one equal to the package's pin (3.6). |
| `vulnerabilities` | `null` or an object of six non-negative integer counts | `fixable_*` = critical/high findings with a `FixedVersion`. |
| `secrets.count` | non-negative integer | `findings` capped at 20 by the scanner. |
| `malware.count` | non-negative integer | |
| `smoke.status` | `pass` \| `fail` \| `skipped` | `exit_code`, `duration_ms`, `output_excerpt` optional. |
| `smoke.sample` | optional object | Sent only on `pass` with non-empty stdout: `output_format`, then either `entities` (first 5, each ≤ 500 chars, from a json `{entities: [...]}`/array or jsonl lines with `type` and `value`) with `entity_count`, or `stdout` (first 2000 chars). `trimSample` (`scans.ts`) re-caps it on arrival. Stored in the `smoke` scan row and served by `GET /tools/:ns/:name` as `sample` for the latest version. |
| `sbom` | optional `{packages}` | Stored as an `sbom` scan row when present. |
| `scanner_version` | optional string | |

`parseResults` checks (400 `invalid_scan_results`, message `scan results: <what>`), in this order: body is an
object; `signature.status` in the set; `signature.identities`, when present, is at most 20 `{identity ≤ 500, issuer
≤ 200}` strings; `secrets.count` is a count; `malware.count` is a count; `smoke.status` in the
set; `vulnerabilities` is `null` or has all six keys as counts. A count is an integer ≥ 0. Extra fields are kept
(stored in `summary_json`).

Other errors:

| Status | Code | When |
| --- | --- | --- |
| 401 | `unauthenticated` | No `Bearer` token. |
| 413 | `payload_too_large` | `Content-Length` over 256 KiB (`MAX_RESULTS`). |
| 401 | `invalid_scan_token` | No version with that token hash, unexpired, in status `scanning` (unknown, expired or already used). |

Handling (`applyScanResults`):

1. `previouslySigned` = another version of the tool that is `published` or `yanked` has `signer_identity`.
2. A direct upload (`publish_jobs.provider = 'direct'`) goes through `pinSigner` first (3.6), then the verdict (3.6).
3. Inserts `scans` rows: `signature` (fail/pass/warn for absent), `vuln` (warn if fixable critical+high > 0 else
   pass), `malware` (fail if malware+secrets > 0; summary holds both), `smoke` (fail/pass/warn for skipped), and
   `sbom` (pass) if present.
4. Clears `scan_token_hash` and `scan_token_expires_at` in the same batch: **the token is single-use**.
5. Fail: version `rejected` (`rejected_reason` = code), publish job `rejected` with `error_code`/`error_detail`,
   audit `scan.rejected`, failure commit status, `rejected` email.
6. Pass/warn: stores `scan_status` and the signer; if the namespace is `active`, `publishVersion(..., {backupInline:
   true})` (no queued backup, since the scanner will do it); otherwise version and job go to `awaiting_review`,
   pending commit status "Scans passed; new publisher awaiting review", `in_review` email.

Response:

```json
{
  "status": "published",
  "verdict": { "result": "warn" },
  "backup": { "run_id": "...", "ref": "ns/name", "complete_url": "...", "token": "...", "expires_at": 0, "items": [] }
}
```

- `status`: `published` | `awaiting_review` | `rejected`.
- `verdict`: `{result: "pass"|"warn"}` or `{result: "fail", code, message}`.
- `backup`: only when `status` is `published` and `releasePlan` returned a plan (it returns `null` when nothing needs
  backing up; an error building it is logged and the key is omitted). Its shape is the `BackupPlan` in 4.2. A
  version approved later by a reviewer is backed up through the queue (`backupVersionId`) instead.

### 3.6 Verdict rules (`verdict`), exactly

For a direct upload, `pinSigner` (`scans.ts`) runs first when the signature passed:

- **The pin.** It is the `signer_identity` and `signer_issuer` of the tool's earliest non-rejected signed version, compared
  by `signerKey`, which drops a trailing `@refs/...`.
- **With a pin.** A reported identity (from `identities`, else `identity`) equal to the pin is recorded. If none
  matches, the signature becomes `fail` with detail `signed by <identities>, not by <pin>, which signed this package's
  earlier versions` (rule 1 below).
- **Without a pin.** More than one distinct identity fails before the table, with `signature_ambiguous`. Otherwise the
  first identity is recorded and becomes the pin.

Then, checked in this order; the first match wins:

| # | Condition | Result | Code | Message |
| --- | --- | --- | --- | --- |
| 1 | `signature.status === "fail"` | fail | `signature_mismatch` | `signature did not verify: <detail ?? "identity mismatch">` |
| 2 | `signature.status === "absent"` and an earlier published/yanked version was signed | fail | `signature_dropped` | `earlier versions were signed but this one is not; sign it with the release workflow` (for a direct upload: `sign it with the same identity as before`) |
| 3 | `malware.count > 0` | fail | `malware_suspected` | `<n> malicious-code heuristic(s) matched; a reviewer will look at the report` |
| 4 | `secrets.count > 0` | fail | `secrets_found` | `<n> embedded secret(s) found in the artifact; rotate them and rebuild` |
| 5 | `smoke.status === "fail"` | fail | `smoke_test_failed` | `the test input exited with code <exit_code ?? "?">: <output_excerpt, first 200 chars>` |
| 6 | `vulnerabilities` not null and `fixable_critical + fixable_high > 0` | warn | – | – |
| 7 | otherwise | pass | – | – |

Not failing: an absent signature on a tool that was never signed; unfixable vulnerabilities of any severity; medium
and low vulnerabilities; a skipped smoke test. Warn still publishes (the `published` email notes it).

---

## 4. Backups

### 4.1 Constants (`backups.ts`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_BUNDLE_BYTES` | 500 × 1024² (500 MiB) | git bundles |
| `MAX_IMAGE_BYTES` | 2 × 1024³ (2 GiB) | images, all platforms' configs and layers summed |
| `MAX_WHEEL_BYTES` | 1024³ (1 GiB) | wheels |
| `RELEASE_TTL` | 3 h | run token and upload URL lifetime for release/manual runs |
| `WEEKLY_TTL` | 12 h | same, for weekly git runs |
| `DOWNLOAD_TTL` | 3600 s | owner restore download link |
| `DRILL_TTL` | 6 h | drill token and bundle download URL |
| `KEEP_WEEKLY` | 4 | weekly bundles kept per package |
| `TAKEDOWN_GRACE` | 14 days | delay before taken-down backups are deleted (the stated rule is "within 30 days") |
| `WEEKLY_PER_DISPATCH` | 20 | weekly plans per `otinstaller-backup` event |
| `BACKFILL_PER_RUN` | 5 | versions backfilled per 15-minute run |
| `BACKFILL_RETRY` | 1 day | a version gets at most one backfill run a day |

Each plan item carries `max_bytes` from this table, and the scanner enforces it before uploading.

### 4.2 `client_payload.backup` and the inline `backup` answer

Both carry `BackupPlan` objects. Dispatched: `{ "backup": { "jobs": [plan, ...] } }`. Inline: the scan callback's
`backup` key is a single plan.

```json
{
  "backup": {
    "jobs": [
      {
        "run_id": "01J...ULID",
        "ref": "osintverse-community/dns-lookup",
        "complete_url": "https://api.otinstaller.com/v1/internal/backups/01J...ULID",
        "token": "<single-use run token>",
        "expires_at": 1790000000000,
        "items": [
          {
            "id": "01J...ITEM",
            "kind": "image",
            "max_bytes": 2147483648,
            "source": "ghcr.io/osintverse-community/dns-lookup@sha256:<hex>",
            "target": "mirror.otinstaller.com/osintverse-community/dns-lookup",
            "digest": "sha256:<hex>",
            "visibility": "public"
          },
          {
            "id": "01J...ITEM",
            "kind": "wheel",
            "max_bytes": 1073741824,
            "key": "wheels/<ns>/<name>/<sha256>.whl",
            "sha256": "<64 hex>",
            "package": "tldextract",
            "version": "5.1.2",
            "upload_url": "<signed PUT URL>"
          },
          {
            "id": "01J...ITEM",
            "kind": "git",
            "max_bytes": 524288000,
            "key": "git/github/<project_id>/2026-10-21-v1.2.0.bundle",
            "clone_url": "https://github.com/osintverse-community/dns-lookup.git",
            "upload_url": "<signed PUT URL>"
          }
        ]
      }
    ]
  }
}
```

Plan fields:

| Field | Meaning |
| --- | --- |
| `run_id` | `backup_runs.id`. |
| `ref` | `<ns>/<name>` (no version), for logs. |
| `complete_url` | `${API_URL}/v1/internal/backups/<run_id>`, where the report goes. |
| `token` | Plaintext single-use token; `backup_runs.token_hash` holds its SHA-256. |
| `expires_at` | Unix ms; now + `RELEASE_TTL` or `WEEKLY_TTL`. |
| `items[]` | One per thing to back up; each has `id` (`backups.id`), `kind`, `max_bytes`. |

Item fields by kind:

| Kind | Fields | Notes |
| --- | --- | --- |
| `image` | `source` (manifest's `runtime.image`), `target` (`<MIRROR_HOST>/[private/]<ns>/<name>`), `digest`, `visibility` | `private/` prefix when the license is not OSI-approved (`osiApproved`). No upload URL: the scanner pushes to the mirror. |
| `wheel` | `key`, `sha256` (manifest `wheel_sha256`), `package`, `version` (`package_version ?? m.version`), `upload_url` | Stored at `wheels/<ns>/<name>/<sha256>.whl` in `otinstaller-backups`. |
| `git` | `key`, `clone_url`, `upload_url` | Release: `git/<provider>/<project_id>/<YYYY-MM-DD>-v<version>.bundle`; weekly: `...-weekly.bundle`. `clone_url` is the source URL with `.git` appended for github.com/gitlab.com. Always stored with visibility `private`. |

What gets planned (`releasePlan`, for a version in `published` or `yanked`, tool not `removed`):

- image, if `runtime.kind = docker`, the image contains `@sha256:` and no `stored` image backup exists for the version;
- wheel, if `runtime.kind = pipx`, `wheel_sha256` and `package` are set and no stored wheel backup exists;
- git, if `gitEligible` (tool `git_backups = 1`, a source with provider and URL, `sync_status != 'unavailable'`,
  visibility public or null) and no stored git backup exists for the version.

If nothing is planned the result is `null` (no run). Weekly runs (`weeklyBackups`, cron `41 4 * * 1`) plan only a
git item for every active, public, non-paused source of a tool with a latest version and `git_backups = 1`.

`dispatchBackups` marks each run `dispatched` on success, or the run and its pending items `failed` with the error
when the dispatch throws.

### 4.3 Signed upload/download URLs (`signedUrl`)

- With `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` all set: an S3 SigV4 presigned URL on
  `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<BACKUPS_BUCKET ?? "otinstaller-backups">/<key>`, region `auto`,
  `X-Amz-Expires` = TTL. Uploads go straight to R2.
- Otherwise: `${API_URL}/v1/internal/backups/objects/<key>?method=<GET|PUT>&expires=<unix s>&sig=<hex>`, where
  `sig` = HMAC-SHA256 with key `backup-url|<TOKEN_ENC_KEY>` over `"<method>\n<key>\n<expires>"`. Needs
  `TOKEN_ENC_KEY` (503 `not_configured` otherwise). The routes check: `method` query matches the HTTP method,
  `expires` not past (403 `url_expired`), key has no `..` and starts with `git/` or `wheels/` (403
  `invalid_signature`), signature matches (403 `invalid_signature`). `PUT` needs `Content-Length` (400
  `length_required`) and refuses bodies over the prefix's limit (413 `too_large`: 500 MiB for `git/`, 1 GiB for
  `wheels/`), but Workers cap request bodies at 100 MB, so this path is for local development and small objects.

Expiry: upload URLs live as long as the run (3 h release/manual, 12 h weekly). The drill's bundle GET URL lives 6 h;
an owner's restore link 1 h. The URLs themselves are not single-use; they can be reused until they expire.

### 4.4 What `backup.py` does

`run_backup_request(req)` loops over `req["jobs"]`; `run_job(job, work)` handles each item (a failure in one item
becomes `{status: "failed", detail}` and does not stop the others), then posts the report. Exit code 1 if any item
failed or a job could not report.

- **image** (`mirror_image`): `crane manifest` of the source (and each platform manifest of an index) to sum config
  and layer sizes. Over `max_bytes` → `too_large` with `size_bytes`. Layers over 90 MB are first pushed to the mirror
  with an OCI chunked upload in 50 MB chunks (`crane blob` piped), using a push token from `<mirror>/token` with
  Basic `scanner:<MIRROR_PUSH_TOKEN>` (raises if `MIRROR_PUSH_TOKEN` is unset). Then `crane copy [--jobs
  $CRANE_JOBS] <source> <target>@<digest>`, then the signature tags `sha256-<hex>.sig`, `.att`, `.sbom` and
  `sha256-<hex>` when present at the source (`crane digest`, then `crane copy`), then checks `crane digest
  <target>@<digest>` equals the digest. Result: `{status: "stored", size_bytes, detail: "copied <tags>"}`.
- **wheel** (`backup_wheel`): reuses a wheel in the scan's work dir with the right sha256, else downloads it from
  PyPI and re-hashes. Over `max_bytes` → `too_large`. `PUT` to `upload_url` with `Content-Length` (accepts 200, 201,
  204; R2's XML `<Code>` is kept in the error). Result: `{status: "stored", size_bytes, sha256, filename}`.
- **git** (`backup_git`): `git clone --mirror` (with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`); if the mirror is
  over twice `max_bytes` → `too_large`; `git bundle create <bundle> --branches --tags` (no `refs/pull/*` etc.); over
  `max_bytes` → `too_large`; `git bundle verify`; counts refs with `git bundle list-heads`; uploads. Result:
  `{status: "stored", size_bytes, sha256, refs_count}`.

### 4.5 Report: `POST /v1/internal/backups/:run`

```
POST /v1/internal/backups/<run_id>
Authorization: Bearer <plan token>
Content-Type: application/json
```

```json
{
  "items": [
    { "id": "01J...ITEM", "status": "stored", "size_bytes": 81234567, "detail": "copied sha256-<hex>.sig" },
    { "id": "01J...ITEM", "status": "stored", "size_bytes": 120345, "sha256": "<hex>", "filename": "tldextract-5.1.2-py3-none-any.whl" },
    { "id": "01J...ITEM", "status": "stored", "size_bytes": 3456789, "sha256": "<hex>", "refs_count": 14 },
    { "id": "01J...ITEM", "status": "too_large", "size_bytes": 2300000000 },
    { "id": "01J...ITEM", "status": "failed", "detail": "git clone failed: ..." }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | The plan item's `id` (required, string). |
| `status` | `stored` \| `too_large` \| `failed` (required). |
| `size_bytes` | Size the scanner measured. For images it is the only size check the API can do. |
| `sha256` | Wheels: must equal the manifest's `wheel_sha256`. Git: the bundle's hash (used by drills). |
| `filename` | Wheels: stored after stripping characters outside `[A-Za-z0-9._+-]`, max 200; served at `/v1/tools/:ns/:name/:version/wheel/<filename>`. |
| `refs_count` | Git: number of refs in the bundle. |
| `detail` | Free text, truncated to 500 chars. |

Validation in the route (400 `invalid_body`): body must have an `items` array of at most 10 entries, each with a
string `id` and a valid `status`. No token → 401 `unauthenticated`. This route does not use `parseResults`.

`completeRun`:

- The run must match `id`, `token_hash`, `expires_at > now` and status `pending` or `dispatched`, else 401
  `invalid_backup_token` ("unknown, expired or already used backup token").
- For every planned row (not only the reported ones): unreported → `failed` "not reported by the scanner".
- `stored` git/wheel: `BACKUPS.head(key)`; missing → `failed` "the upload did not arrive"; over the kind's limit →
  object deleted, `too_large`; wheel whose reported `sha256` differs from the manifest → object deleted, `failed`.
- `stored` image: `imageExists(MIRROR, repo, digest)` must be true (else `failed` "the image is not in the mirror");
  reported `size_bytes` over 2 GiB → image deleted from the mirror, `too_large`.
- Run set `completed`, `token_hash = NULL` (**single-use**), audit `backup.completed` with each kind's outcome.
- If the tool or version was removed while copying, `scheduleDeletion` applies to what just arrived.
- `pruneWeekly` keeps the latest 4 stored weekly bundles; older ones are deleted from R2 and marked `deleted`.
- Any `too_large` → `backup_too_large` email to the namespace owners.

Response: `{ "status": "completed", "items": { "image": "stored", "wheel": "...", "git": "..." } }` (keyed by kind).

Runs that never report: `expireRuns` (every 15 minutes) marks runs past `expires_at` `expired` (token cleared) and
their pending items `failed` "the backup job did not report back". The backfill (every 15 minutes, 5 versions,
once a day per version) retries published versions in active namespaces that have no `stored`, `pending` or
`too_large` image/wheel backup.

### 4.6 Takedowns, legal holds, opt-outs

- `scheduleDeletion` (on removal): hides each mirrored image at once (`hidden/<repo>@<digest>` marker in the mirror
  bucket; a whole-package removal also hides `<ns>/<name>` and `private/<ns>/<name>`), and, unless the tool is on
  legal hold, sets `delete_after = now + 14 days` on its backups. Hidden images are not served to the public.
- `purgeBackups` (nightly, up to 200 per run): deletes due backups whose tool has `legal_hold = 0`.
- Legal hold on: clears `delete_after` on all non-deleted backups. Released: re-schedules deletion for removed
  tools/versions, and git backups again if the owner had opted out.
- Git opt-out (`PATCH /v1/packages/:ns/:name/backups {git_backups:false}`): sets `delete_after = now` on git backups
  (deleted at the next nightly purge) unless on legal hold. Images and wheels stay.
- `installFallbacks` only exposes public, stored backups with `delete_after IS NULL`.

---

## 5. Restore drills

### 5.1 `client_payload.drill`

`startDrill` picks one random stored git bundle (not scheduled for deletion, tool not removed) and one random stored
**public** image backup of a `published` version. If neither exists it returns `null` (admin endpoint answers
`nothing_to_drill`). It inserts a `restore_drills` row (status `dispatched`, token hash, expiry now + 6 h) and sends:

```json
{
  "drill": {
    "id": "01J...ULID",
    "callback_url": "https://api.otinstaller.com/v1/internal/drills/01J...ULID",
    "token": "<single-use drill token>",
    "bundle": { "url": "<signed GET URL, 6 h>", "sha256": "<hex or null>", "refs": 14 },
    "image": {
      "ref": "mirror.otinstaller.com/<ns>/<name>@sha256:<hex>",
      "signer_identity": "https://github.com/.../.github/workflows/...@refs/heads/main",
      "signer_issuer": "https://token.actions.githubusercontent.com"
    }
  }
}
```

`bundle` or `image` is `null` when there is nothing of that kind. `signer_identity`/`signer_issuer` are the
version's stored signer (may be `null` for unsigned images). If the dispatch fails, the drill is finished as `fail`
at once and admins are emailed.

### 5.2 What `backup.drill` does

- Bundle: downloads `url`, checks `sha256` when given, then `git init --bare` an empty repo, `git clone --mirror
  <bundle>`, `git push --mirror` into the empty repo, `git fsck --full`, and compares `git ls-remote` with the
  bundle's heads (missing refs → fail).
- Image: `crane digest <ref>` must equal the digest; `docker pull <ref>` if Docker exists; `cosign verify
  --certificate-identity <signer_identity> --certificate-oidc-issuer <signer_issuer>` when a signer is set.
- Exit 0 only when there was at least one check and all passed.

### 5.3 Report: `POST /v1/internal/drills/:id`

```
POST /v1/internal/drills/<id>
Authorization: Bearer <drill token>
```

```json
{
  "result": "pass",
  "detail": "bundle: pass; image: pass",
  "checks": [
    { "check": "bundle", "result": "pass", "refs": 14 },
    { "check": "image", "result": "pass", "signature": "verified" }
  ]
}
```

- No body validation beyond JSON (an unparsable body becomes `{}`), so anything but `result: "pass"` is a fail.
- The drill must match `id`, token hash, status `dispatched` and `expires_at > now`, else 401 `invalid_drill_token`.
- Stored `detail` = `detail` + newline + JSON of `checks`, truncated to 2000 chars; `token_hash` cleared
  (**single-use**); a non-pass emails admins (`drillFailed`).
- Response: `{ "status": "pass" | "fail" }`.
- Drills that never report: `expireDrills` (every 15 minutes) finishes them as `expired` ("did not report back within
  6 hours") and emails admins.

---

## 6. Health checks

### 6.1 Auth

Both endpoints use the static shared secret `HEALTH_TOKEN` (API secret and registry-ops secret). It is **not**
single-use. Missing on the server → 503 `not_configured`; missing or wrong Bearer → 401 `unauthenticated`. The
comparison is of SHA-256 digests (constant-length, to avoid timing leaks).

### 6.2 `GET /v1/internal/health/targets`

Targets: every tool (`kind = 'tool'`, not `removed`, namespace `active`) whose **latest** version's manifest has
`test.input`.

```json
{
  "targets": [
    {
      "version_id": "01J...",
      "ref": "osintverse-community/dns-lookup",
      "version": "1.2.0",
      "runtime": { "kind": "docker", "image": "...@sha256:...", "command": ["..."] },
      "test_input": { "domain": "example.com" },
      "expect_exit_code": 0,
      "domains": ["dns.google"]
    }
  ]
}
```

`domains` = `network.domains ?? []`; used only to space out checks.

### 6.3 `POST /v1/internal/health`

```json
{
  "results": [
    { "version_id": "01J...", "result": "pass", "duration_ms": 3120, "error_excerpt": "" },
    { "version_id": "01J...", "result": "fail", "duration_ms": 120000, "error_excerpt": "timed out" }
  ]
}
```

Validation: `results` must be an array of at most 500 (400 `invalid_body`). Entries with an unknown `version_id` or
a `result` other than `pass`/`fail` are skipped silently. Response: `{ "applied": <n> }`.

`applyHealth` per result:

- Inserts a `health_checks` row (`error_excerpt` keeps the last 1000 chars), keeps the newest 30 per tool.
- `health_fail_streak`: 0 on pass, +1 on fail. `health_checked_at` = now.
- `health_status`: `healthy` on any pass; `broken` (shown as "Possibly broken") when the streak reaches 3
  (`BROKEN_AFTER`); otherwise unchanged.
- On the first failure of a run (streak becomes 1) the owners get one `health` email; not every night.
- Broken tools are excluded from the pivots list and penalised in search ranking.

### 6.4 `ops/scanner/health.py`

Needs `REGISTRY_API` (origin, e.g. `https://api.otinstaller.com`; `/v1` is appended) and `HEALTH_TOKEN`.

- `health.py targets`: GETs targets, prints `[{"n": 0, "targets": [...10...]}, ...]` (batches of 10) for the matrix.
- `health.py run batch.json`: for each target, waits so the same domain is hit at most every 20 s
  (`PER_DOMAIN_GAP`), builds the image (Docker: `docker pull`; pipx: fetches the pinned wheel from PyPI and builds
  the same `python:3.12-slim` image as the scanner, tag `ot-health/<slug>:latest`), runs `scan.smoke(...,
  egress=True)` (always with network, unlike the publish smoke test), and maps pass/fail. Any exception is a `fail`
  with the exception text. Then POSTs all results at once.

---

## 7. Workflows (registry-ops)

### 7.1 `ops/workflows/scan.yml`

- Trigger: `repository_dispatch` types `otinstaller-scan`, `otinstaller-backup`, `otinstaller-drill`.
- Permissions: `contents: read`.
- Concurrency group: `<action>-<scan.version_id || drill.id || run_id>`, no cancel-in-progress.
- One job on `ubuntu-latest`, 60-minute timeout.
- Env: `MIRROR_PUSH_TOKEN` = `secrets.MIRROR_PUSH_TOKEN`; `MIRROR_HOST` = `vars.MIRROR_HOST || 'mirror.otinstaller.com'`.
- Steps:
  1. `actions/checkout@v5`
  2. scan only: `aquasecurity/setup-trivy@v0.3.1` (Trivy v0.76.0)
  3. `sigstore/cosign-installer@v4.1.2` (cosign v3.1.3)
  4. `imjasonh/setup-crane@v0.4`
  5. `actions/setup-python@v6` (3.12)
  6. scan only: `pip install guarddog==3.2.0 cryptography==50.0.2`
  7. if `MIRROR_PUSH_TOKEN` set: `crane auth login "$MIRROR_HOST" -u scanner --password-stdin`, then the same with
     `docker login` (images publishers pushed to the mirror are only served to this credential until they are
     published, and the scan pulls them with Docker)
  8. writes `toJSON(github.event.client_payload)` to `$RUNNER_TEMP/request.json`
  9. `python3 ops/scanner/scan.py "$RUNNER_TEMP/request.json" --post`
- Docker is the runner's preinstalled engine (no setup step).

Note: `MIRROR_HOST` is only used for the crane login; `scan.py`/`backup.py` take the mirror host from each item's
`target`, so the variable must match the API's `MIRROR_HOST`. Backup and drill events run without Trivy, GuardDog or
`cryptography` (not needed there).

### 7.2 `ops/workflows/health.yml`

- Triggers: cron `0 2 * * *` (02:00 UTC) and `workflow_dispatch`. Permissions `contents: read`. Concurrency group
  `health`, no cancel.
- Job `targets`: `python3 ops/scanner/health.py targets` → output `batches`.
- Job `check` (skipped when `batches == '[]'`): matrix over batches, `fail-fast: false`, `max-parallel: 20`,
  60-minute timeout; writes the batch to `$RUNNER_TEMP/batch.json` and runs `health.py run`.
- Env for both: `REGISTRY_API` = `vars.REGISTRY_API`, `HEALTH_TOKEN` = `secrets.HEALTH_TOKEN`.
- No Trivy, cosign or crane is installed; it uses the runner's Docker and Python. Images are not cosign-verified
  during health checks.

### 7.3 Local runs

`ops/scanner/Dockerfile` (`python:3.12-slim` with Docker CLI 29.9.1, Trivy 0.76.0, cosign 3.1.3, crane 0.20.6, git,
GuardDog 3.2.0, cryptography 50.0.2; entrypoint `scan.py`):

```
docker build -t otinstaller-scanner ops/scanner
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/req.json:/req.json" otinstaller-scanner /req.json
```

The image copies only `scan.py` and `backup.py` (not `health.py`). `POST /v1/admin/tools/:ns/:name/:version/backup`
with `{"dispatch": false}` returns `{status: "created", job: {backup: {jobs: [plan]}}}`, which `scan.py` accepts as a
file as it is.

### 7.4 Environment and tools summary

| Script | Args | Env vars | Shells out to |
| --- | --- | --- | --- |
| `scan.py` | `<request.json> [--post]` | none for scans; `MIRROR_PUSH_TOKEN` and optional `CRANE_JOBS` via `backup.py` | `docker` (pull, build, run), `cosign` (verify, download signature), `trivy`, `guarddog` (optional), Python `cryptography` |
| `backup.py` | called from `scan.py` | `MIRROR_PUSH_TOKEN` (needed for layers over 90 MB; pushes otherwise rely on `crane auth login`), `CRANE_JOBS` (optional `crane copy --jobs`) | `crane` (manifest, blob, copy, digest), `git`, `docker` (drill pull, optional), `cosign` (drill verify) |
| `health.py` | `targets` \| `run <batch.json>` | `REGISTRY_API`, `HEALTH_TOKEN` (both required; KeyError otherwise) | `docker` (pull, build, run) |

---

## 8. Token and limit summary

| Token | Created | Stored | Lifetime | Single-use | Cleared by |
| --- | --- | --- | --- | --- | --- |
| Scan `callback_token` | `dispatchScan` | `versions.scan_token_hash` | 1 h | yes | `applyScanResults`; `expireStaleScans` rejects with `scan_timeout` |
| Backup run `token` | `createRun` | `backup_runs.token_hash` | 3 h (release/manual), 12 h (weekly) | yes | `completeRun`; `expireRuns` |
| Drill `token` | `startDrill` | `restore_drills.token_hash` | 6 h | yes | `finishDrill` (complete or expire) |
| `HEALTH_TOKEN` | operator | API secret and registry-ops secret | static | no | – |
| `MIRROR_PUSH_TOKEN` | operator | mirror Worker secret and registry-ops secret | static | no | – |
| Mirror bearer tokens | `/token` on the mirror | not stored (HMAC-signed) | 300 s | no | – |
| Signed object URLs | `signedUrl` | not stored | same as the run / 6 h drill / 1 h restore | no | – |

| Limit | Value |
| --- | --- |
| Scan results body | 256 KiB (`Content-Length`) |
| Backup report items | 10 per request |
| Health results | 500 per request |
| Image backup | 2 GiB (all platforms) |
| Wheel backup | 1 GiB |
| Git bundle | 500 MiB (clone over 1000 MiB is rejected before bundling) |
| API-proxied upload | 100 MB in practice (Workers request body cap) |
| Mirror manifest | 4 MiB |
| Mirror chunked upload threshold | layers over 90 MB, sent in 50 MB chunks |
| Smoke test | 120 s, 1 GiB memory, 256 pids, 256 MiB `/tmp` |
