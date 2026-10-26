# Configuration and secrets per deployable

Names only; no values. Derived from `api/wrangler.jsonc`, `api/wrangler.mirror.jsonc`, `api/src/env.ts`,
`api/.dev.vars.example`, `api/src/mirror/registry.ts`, `ops/get/*`, `ops/workflows/*.yml`, `.github/workflows/release-cli.yml`
and `cli/.goreleaser.yaml`.

"Unset" behaviour: `requireSecret(env, NAME)` throws `apiError(503, "not_configured", "<NAME> is not configured on
this server")` at the moment the value is needed, so a missing secret only breaks the feature that uses it.

## Domains at a glance

| Worker | Config | Route (custom domain) |
| --- | --- | --- |
| `otinstaller-registry-api` | `api/wrangler.jsonc` | `api.otinstaller.com` |
| `otinstaller-mirror` | `api/wrangler.mirror.jsonc` | `mirror.otinstaller.com` |
| `otinstaller-registry-web` | `web/wrangler.jsonc` in the site's repository | `otinstaller.com`, `www.otinstaller.com` |
| `otinstaller-get` | `ops/get/wrangler.jsonc` | `get.otinstaller.com` |

All four use `"custom_domain": true` (Cloudflare creates the DNS record on deploy). There are no `env` blocks; each
file is production config.

---

## 1. `otinstaller-registry-api`

`main: src/index.ts`, `compatibility_date: 2026-10-01`, `compatibility_flags: ["nodejs_compat"]`.

### 1.1 Bindings

| Binding | Type | Resource | Used for |
| --- | --- | --- | --- |
| `DB` | D1 | `otinstaller` (`migrations_dir: migrations`) | everything |
| `CONTENT` | R2 | `otinstaller-content` | rendered READMEs, guide pages, tool docs, images |
| `BACKUPS` | R2 | `otinstaller-backups` | git bundles (`git/...`) and wheels (`wheels/...`) |
| `MIRROR` | R2 | `otinstaller-mirror` (shared with the mirror Worker) | `imageExists` checks, hiding and deleting taken-down images |
| `PUBLISH_QUEUE` | Queue producer | `otinstaller-publish` | publish jobs, imports, content checks, link checks, approved publishes, backups |
| (consumer) | Queue consumer | `otinstaller-publish` | `max_batch_size: 5`, `max_retries: 5`, `retry_delay: 30` |
| `caches.default` | Cache API (implicit) | – | edge cache for anonymous GETs (`edge-cache.ts`) |

Cron triggers: `17 3 * * *` (nightly), `*/15 * * * *`, `41 4 * * 1` (weekly git backups), `23 5 1 * *` (monthly
restore drill).

### 1.2 Plain vars (`vars` in `wrangler.jsonc`)

| Name | Required | Purpose | When unset |
| --- | --- | --- | --- |
| `SITE_URL` | yes | site origin: CORS (credentialed only for it), sign-in redirects, email links, commit-status links, edge-cache key | not optional in `Env`; URL building breaks |
| `API_URL` | yes | public API origin: OAuth callbacks, scan/backup/drill callback URLs, signed object URLs, `wheel_url` | not optional; callbacks would point nowhere |
| `OPS_REPO` | for scans/backups/drills | registry-ops repo for `repository_dispatch`; also names the identity that signs pipx sandbox images (`scan.yml` on `main`) | `requireSecret` → 503 on dispatch; no sandbox images offered |
| `SANDBOX_SIGNER_IDENTITY` | no | the cosign identity ot checks pipx sandbox images against, when registry-ops' default branch isn't `main` or the workflow moves | `https://github.com/<OPS_REPO>/.github/workflows/scan.yml@refs/heads/main` |
| `EMAIL_FROM` | no | sender address | defaults to `OTInstaller Registry <registry@otinstaller.com>` |
| `MIRROR_HOST` | no | host in mirror targets and `mirror_image` | defaults to `mirror.otinstaller.com` |
| `GITHUB_APP_SLUG` | no (commented out) | App install link `https://github.com/apps/<slug>/installations/new` | defaults to `otinstaller` |
| `INDEXNOW_KEY` | no | IndexNow key (`indexnow.ts`); public by design, must equal the name and content of the site's `web/public/<key>.txt` | nothing queued or sent (also off when `SITE_URL` is http or localhost; tests set it to `""`) |

### 1.3 Secrets and optional settings (from `env.ts`)

| Name | Required | Purpose | When unset | In wrangler comment | In `.dev.vars.example` |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_APP_ID` | yes (GitHub publishing) | App JWT: installation tokens for repos and (fallback) registry-ops dispatch, imports | 503 on use | yes | yes |
| `GITHUB_APP_PRIVATE_KEY` | yes | PKCS#8 PEM for the App JWT | 503 on use | yes | yes |
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC check on `POST /v1/webhooks/github` | 503 on every GitHub webhook | yes | yes |
| `UPSTREAM_WATCH` (var) | no | What the upstream watcher does: `report` (default) records; `issues` also opens and closes outdated issues on community wrappers; `prs` also has the community bot open bump pull requests; `auto` also merges and releases pin-only bumps a week after upstream's release. The build watcher does the same with first-party tools' requirements.txt pins | report only | yes | no |
| `REBUILD_WATCH` (var) | no | `rebuild` has the community bot rebuild a package on a newer base image when its scan found fixable critical or high vulnerabilities (build-watch.ts); anything else only records base image changes | report only | yes | no |
| `COMMUNITY_APP_ID` / `COMMUNITY_APP_PRIVATE_KEY` / `COMMUNITY_INSTALLATION_ID` | for community submissions | The community bot: a second GitHub App installed only on `osintverse-community` that creates wrapper repositories, commits their files, tags or dispatches their release and archives turned-down ones (`submissions.ts`) | 503 `community_bot_missing` on submit; the rest of the site works | yes | no |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes (GitHub sign-in) | OAuth sign-in | 503 on GitHub login | yes | yes |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | yes (GitLab) | GitLab OAuth sign-in and refreshing stored GitLab tokens (`hosts/repo.ts`) | 503 on GitLab login and GitLab repo calls | yes | yes |
| `OSINTVERSE_CLIENT_ID` / `OSINTVERSE_CLIENT_SECRET` | for that sign-in | Sign in with OSINTverse (confidential OIDC client) | 503; the button fails | yes | yes |
| `OSINTVERSE_ISSUER` | no | OIDC issuer | defaults to `https://osintverse.com/api/auth` | no | no |
| `TOKEN_ENC_KEY` | yes | AES-GCM key for stored provider tokens (32 random bytes, base64); HMAC key for API-proxied backup URLs; salt for rate-limit keys | 503 for sign-in, repo calls and proxied backup URLs; rate-limit keys fall back to the fixed salt `"ot"` | yes | yes |
| `OPS_DISPATCH_TOKEN` | one of this or `OPS_INSTALLATION_ID` | fine-grained token with Contents: write on `OPS_REPO` only | falls back to the App installation token | yes ("or") | no |
| `OPS_INSTALLATION_ID` | one of the two | the App's installation on registry-ops | 503 on dispatch if `OPS_DISPATCH_TOKEN` is also unset | yes ("or") | no |
| `RESEND_API_KEY` | no | email via Resend | emails are recorded with status `skipped` and not sent | yes | no |
| `SENTRY_DSN` | no | error reports to Sentry | no reporting | yes | yes |
| `SENTRY_ENVIRONMENT` | no | Sentry environment tag | `production` | no | no |
| `CF_URLSCAN_ACCOUNT_ID` / `CF_URLSCAN_TOKEN` | no | Cloudflare URL Scanner for guide links | URL Scanner step skipped (needs both) | yes | yes |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | no (needed for real-size backups) | S3 presigned URLs straight to R2 for backup uploads, drill and restore downloads (all three needed) | URLs go through the API (`/v1/internal/backups/objects/*`, HMAC with `TOKEN_ENC_KEY`), capped by the 100 MB Worker body limit | yes | no |
| `BACKUPS_BUCKET` | no | bucket name in presigned URLs | `otinstaller-backups` | no | no |
| `ISSUES_REPO` | no | repo whose open `sev-1` issues the beta metrics count | `OTInstaller/feedback` | no | no |
| `ISSUES_TOKEN` | no | token with Issues: read, needed while that repo is private | anonymous GitHub search; a private repo answers 422 and the count is `null` with a hint | yes | no |
| `EDGE_CACHE` | no | `"off"` sends every anonymous read to D1 | edge cache on (tests set `off` in `vitest.config.ts`) | no | no |

`.dev.vars.example` also sets `SITE_URL` and `API_URL` (local values `http://localhost:4321` and
`http://127.0.0.1:8787`), overriding the production vars from `wrangler.jsonc` in `wrangler dev`.

Not in `.dev.vars.example` at all: `OPS_DISPATCH_TOKEN`, `OPS_INSTALLATION_ID`, `RESEND_API_KEY`, `R2_*`,
`BACKUPS_BUCKET`, `ISSUES_REPO`, `ISSUES_TOKEN`, `EDGE_CACHE`, `SENTRY_ENVIRONMENT`, `OSINTVERSE_ISSUER`,
`GITHUB_APP_SLUG` (`OPS_REPO`, `EMAIL_FROM` and `MIRROR_HOST` come from `wrangler.jsonc` vars locally too).
Not in the `wrangler.jsonc` secrets comment: `SENTRY_ENVIRONMENT`, `ISSUES_REPO`, `OSINTVERSE_ISSUER`, `BACKUPS_BUCKET`,
`EDGE_CACHE`.

GitLab webhooks are not authorised by an env secret: each GitLab source has its own webhook token stored in D1.

---

## 2. `otinstaller-mirror`

`api/wrangler.mirror.jsonc`: `main: src/mirror/index.ts`, `compatibility_date: 2026-10-01`, route
`mirror.otinstaller.com` (custom domain), `limits.cpu_ms: 300000` (blob uploads are joined and hashed in the Worker).
Deploy: `npx wrangler deploy -c wrangler.mirror.jsonc`.

| Name | Kind | Required | Purpose | When unset |
| --- | --- | --- | --- | --- |
| `MIRROR` | R2 binding `otinstaller-mirror` | yes | all registry storage (`repos/...`, `uploads/...`, `hidden/...`, `pending/...`) | – |
| `DB` | D1 binding `otinstaller` (the API's database, same id as `api/wrangler.jsonc`) | for publisher pushes | looks up publishers' `ot_` tokens and namespace membership, counts pushes (`mirror_pushes`, `rate_limits`) | only the scanner credential can push |
| `MIRROR_PUSH_TOKEN` | secret (`wrangler secret put MIRROR_PUSH_TOKEN -c wrangler.mirror.jsonc`) | for pushes | the scanner credential: HTTP Basic (any user name; the scanner uses `scanner`) at `/token` gets a 300 s admin bearer token; also signs bearer tokens (HMAC), including publishers' push grants | no push, delete or `private/` pull is possible (`adm` and `push` are ignored), publishers can't push either; anonymous public pulls still work, tokens are signed with the fixed key `anonymous-pull` |

The same token must be set as the `MIRROR_PUSH_TOKEN` secret in registry-ops. Public repos are anonymous-pull;
deletes and `private/...` reads need admin; writes need admin or, for `<namespace>/<name>`, a publisher's `ot_` token
with the `publish` scope. Taken-down images (`hidden/` markers) return 404 to non-admins, and publishers' unreleased
images (`pending/` markers) to everyone but admin and the repository's publishers. The API reads the same bucket to
check, release (`releaseImage`) and sweep (`sweepRepo`) hosted images, so `MIRROR_HOST` in the API must be the mirror's
real host for `ot publish --image` images to be recognised as hosted.

---

## 3. `otinstaller-registry-web`

The website's Worker. Its configuration (build-time variables, the CSP and how `PUBLIC_API_URL` feeds it) is
documented in the site's own repository. What this repository has to match is in section 7: the API's `SITE_URL` must
be the site's origin for credentialed CORS.

---

## 4. `otinstaller-get`

`ops/get/wrangler.jsonc`: name `otinstaller-get`, `main: worker.js`, `compatibility_date: 2026-10-12`, route
`get.otinstaller.com` (custom domain), observability on. Deploy with `npx wrangler deploy` from `ops/get`.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `RELEASE_REPO` | var | `OTInstaller/ot` (set in config; code falls back to the same) | repo whose latest release's scripts are served |
| `OTLITE_REPO` | var | `OTInstaller/otinstaller` (set in config; code falls back to the same) | repo whose `main` branch serves `otlite/scripts/install.sh` |

Behaviour (`worker.js`):

| Path | Proxies |
| --- | --- |
| `/ot`, `/ot.sh`, `/install.sh` | `https://github.com/<RELEASE_REPO>/releases/latest/download/install.sh` |
| `/ot.ps1`, `/install.ps1` | `.../install.ps1` |
| `/otlite`, `/otlite.sh` | `https://raw.githubusercontent.com/<OTLITE_REPO>/main/otlite/scripts/install.sh` (pipx or uv from PyPI, so no release is involved) |
| `/ot/latest` | `{"version": "vX.Y.Z"}`, read from the `Location` of `https://github.com/<RELEASE_REPO>/releases/latest` (`redirect: "manual"`, no GitHub API limit); only a tag matching `^v\d+\.\d+\.\d+$` is answered, with `cache-control: public, max-age=3600`; otherwise 502 `{"error": {"code": "latest_unknown", ...}}`, `no-store`. Read by `ot self-update` and `ot outdated` (`selfupdate.LatestURL`) |
| anything else | 302 to `https://otinstaller.com/docs/getting-started` |

Upstream fetches use `cf: { cacheTtl: 300, cacheEverything: true }`; responses are `text/plain; charset=utf-8`
with `cache-control: public, max-age=300`. A non-OK upstream answers 502 with a script that fails loudly (`throw
'...'` for PowerShell, `echo 'error: ...' >&2; exit 1` for sh; for otlite it points at `/docs/otlite`),
`cache-control: no-store`. No secrets, no bindings.

---

## 5. registry-ops GitHub Actions (`ops/workflows/*.yml`)

| Name | Kind | Workflow | Purpose | When unset |
| --- | --- | --- | --- | --- |
| `MIRROR_PUSH_TOKEN` | secret | `scan.yml` | `crane auth login` and `docker login <MIRROR_HOST> -u scanner` (Docker pulls publishers' unreleased images for scanning, and pushes pipx sandbox images); chunked pushes of layers over 90 MB in `backup.py` | login step skipped; image backups fail at push (big layers raise immediately); scans of hosted images fail at pull; pipx scans push no sandbox image |
| `MIRROR_HOST` | variable | `scan.yml` | host for the crane login | `mirror.otinstaller.com` |
| `GITHUB_TOKEN` | automatic | `scan.yml` | `actions/checkout` | – |

`scan.yml` is triggered by `repository_dispatch` (`otinstaller-scan`, `otinstaller-backup`, `otinstaller-drill`),
so the API needs `OPS_DISPATCH_TOKEN` or the App installed on registry-ops (`OPS_INSTALLATION_ID`) with Contents:
write. It uses `permissions: contents: read, id-token: write`: the OIDC token signs pipx sandbox images keyless (no key
or secret to configure), and the API's `OPS_REPO` or `SANDBOX_SIGNER_IDENTITY` must name this workflow on the branch
it runs from.

---

## 6. CLI release (`.github/workflows/release-cli.yml`, `cli/.goreleaser.yaml`)

Trigger: push of a tag `v*.*.*`. Permissions: `contents: read`, `id-token: write` (cosign keyless).

| Name | Kind | Purpose |
| --- | --- | --- |
| `RELEASE_GITHUB_TOKEN` | secret | passed as `GITHUB_TOKEN` to GoReleaser: contents: write on the public release repo |
| `OT_RELEASE_KEY` | secret | Ed25519 private key (PEM), written to `$RUNNER_TEMP/release-key.pem` (umask 077) and removed at the end |
| `OT_RELEASE_KEY_FILE` | env (set by the workflow) | path GoReleaser's `openssl pkeyutl -sign` uses to sign `checksums.txt` → `checksums.txt.sig` |
| `TAP_GITHUB_TOKEN` | secret, optional | Homebrew cask (`otinstaller/homebrew-tap`) and Scoop (`otinstaller/scoop-bucket`); uploads skipped when empty |
| `OT_RELEASE_PUBLIC_KEY` | variable | base64 raw public key: filled into `dist/install/install.sh` and `install.ps1` (job fails if the placeholder remains) and linked into `ot` as `selfupdate.PublicKey` |
| `RELEASE_OWNER` / `RELEASE_NAME` | variables, optional | release repo; the workflow defaults them to `OTInstaller` / `ot` (GoReleaser's own fallback is `otinstaller` / `ot`); also linked into `selfupdate.Repo` |
| cosign keyless | OIDC (`id-token: write`) | `cosign sign-blob` of `checksums.txt` → `checksums.txt.cosign.sig` + `.pem` |

After GoReleaser, the workflow runs `go run ./cmd/mcpb -version <ver> -dist dist -out dist/mcpb -release-url ...` in
`cli/` and uploads the six `ot_<ver>_<os>_<arch>.mcpb` bundles and `server.json` with `gh release upload` (using
`RELEASE_GITHUB_TOKEN`). Publishing `server.json` to the MCP Registry is manual: `mcp-publisher` signed in with
`login http --domain otinstaller.com` and the private key matching the site's `web/public/.well-known/mcp-registry-auth`, which
lives outside the repository (`~/.mcp-registry/otinstaller.com.ed25519.hex` on the owner's machine).

## 6a. otlite release (`.github/workflows/release-otlite.yml`)

Trigger: a tag `otlite-v*.*.*`, or `workflow_dispatch` choosing `testpypi` or `pypi`. PyPI trusted publishing, no
tokens. Each project has its own GitHub environment, because PyPI picks one publisher per token exchange:

| Project | pypi.org | test.pypi.org |
| --- | --- | --- |
| `otlite` | `pypi` | `testpypi` |
| `otinstaller` (the shim) | `pypi-otinstaller` | `testpypi-otinstaller` |

otlite is uploaded first, then the shim; a GitHub release is created for the tag.

Neither project exists on test.pypi.org, so the `testpypi` jobs fail until their publishers are added there. A
`pypi` run while `main` has only versions PyPI already has checks both PyPI publishers and uploads nothing: on
25 Oct 2026, right after this repository was split from the website's, run 40182371675 authenticated for otlite and
the shim and skipped every file.

---

## 7. Cross-deployable secrets that must match

| Value | Where |
| --- | --- |
| `MIRROR_PUSH_TOKEN` | mirror Worker secret, registry-ops secret |
| `MIRROR_HOST` | API var, registry-ops variable (both default `mirror.otinstaller.com`) |
| registry-ops' scan workflow and branch | API `OPS_REPO` (or `SANDBOX_SIGNER_IDENTITY`), the identity `scan.yml` signs sandbox images with |
| `SITE_URL` | API var (CORS), the site's build env |
| `INDEXNOW_KEY` | API var, the file name and content of the site's `web/public/<key>.txt` (and its `_headers` rule) |
| `PUBLIC_API_URL` | the site's build env, must be the API's origin |
| `OT_RELEASE_PUBLIC_KEY` | release variable, embedded in `ot` and the install scripts served by `otinstaller-get` |
