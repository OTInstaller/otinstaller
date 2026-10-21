# Configuration and secrets per deployable

Names only; no values. Derived from `api/wrangler.jsonc`, `api/wrangler.mirror.jsonc`, `api/src/env.ts`,
`api/.dev.vars.example`, `api/src/mirror/registry.ts`, `web/wrangler.jsonc`, `web/astro.config.mjs`,
`web/.env.example`, `web/src/lib/api.ts`, `ops/get/*`, `ops/workflows/*.yml`, `.github/workflows/release-cli.yml`
and `cli/.goreleaser.yaml`.

"Unset" behaviour: `requireSecret(env, NAME)` throws `apiError(503, "not_configured", "<NAME> is not configured on
this server")` at the moment the value is needed, so a missing secret only breaks the feature that uses it.

## Domains at a glance

| Worker | Config | Route (custom domain) |
| --- | --- | --- |
| `otinstaller-registry-api` | `api/wrangler.jsonc` | `api.otinstaller.com` |
| `otinstaller-mirror` | `api/wrangler.mirror.jsonc` | `mirror.otinstaller.com` |
| `otinstaller-registry-web` | `web/wrangler.jsonc` | `otinstaller.com`, `www.otinstaller.com` |
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
| `OPS_REPO` | for scans/backups/drills | registry-ops repo for `repository_dispatch` | `requireSecret` → 503 on dispatch |
| `EMAIL_FROM` | no | sender address | defaults to `OTInstaller Registry <registry@otinstaller.com>` |
| `MIRROR_HOST` | no | host in mirror targets and `mirror_image` | defaults to `mirror.otinstaller.com` |
| `GITHUB_APP_SLUG` | no (commented out) | App install link `https://github.com/apps/<slug>/installations/new` | defaults to `otinstaller` |

### 1.3 Secrets and optional settings (from `env.ts`)

| Name | Required | Purpose | When unset | In wrangler comment | In `.dev.vars.example` |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_APP_ID` | yes (GitHub publishing) | App JWT: installation tokens for repos and (fallback) registry-ops dispatch, imports | 503 on use | yes | yes |
| `GITHUB_APP_PRIVATE_KEY` | yes | PKCS#8 PEM for the App JWT | 503 on use | yes | yes |
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC check on `POST /v1/webhooks/github` | 503 on every GitHub webhook | yes | yes |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes (GitHub sign-in) | OAuth sign-in | 503 on GitHub login | yes | yes |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | yes (GitLab) | GitLab OAuth sign-in and refreshing stored GitLab tokens (`hosts/repo.ts`) | 503 on GitLab login and GitLab repo calls | yes | yes |
| `OSINTVERSE_CLIENT_ID` / `OSINTVERSE_CLIENT_SECRET` | for that sign-in | Sign in with OSINTverse (confidential OIDC client) | 503; the button fails | yes | yes |
| `OSINTVERSE_ISSUER` | no | OIDC issuer | defaults to `https://osintverse.com/api/auth` | no | no |
| `TOKEN_ENC_KEY` | yes | AES-GCM key for stored provider tokens (32 random bytes, base64); HMAC key for API-proxied backup URLs; salt for rate-limit keys | 503 for sign-in, repo calls and proxied backup URLs; rate-limit keys fall back to the fixed salt `"ot"` | yes | yes |
| `OPS_DISPATCH_TOKEN` | one of this or `OPS_INSTALLATION_ID` | fine-grained token with Contents: write on `OPS_REPO` only | falls back to the App installation token | yes ("or") | no |
| `OPS_INSTALLATION_ID` | one of the two | the App's installation on registry-ops | 503 on dispatch if `OPS_DISPATCH_TOKEN` is also unset | yes ("or") | no |
| `RESEND_API_KEY` | no | email via Resend | emails are recorded with status `skipped` and not sent | yes | no |
| `HEALTH_TOKEN` | for health checks | shared with registry-ops' health workflow | `/v1/internal/health*` answer 503 `not_configured` | **no** | yes |
| `SENTRY_DSN` | no | error reports to Sentry | no reporting | **no** | yes |
| `SENTRY_ENVIRONMENT` | no | Sentry environment tag | `production` | no | no |
| `CF_URLSCAN_ACCOUNT_ID` / `CF_URLSCAN_TOKEN` | no | Cloudflare URL Scanner for guide links | URL Scanner step skipped (needs both) | yes | yes |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | no (needed for real-size backups) | S3 presigned URLs straight to R2 for backup uploads, drill and restore downloads (all three needed) | URLs go through the API (`/v1/internal/backups/objects/*`, HMAC with `TOKEN_ENC_KEY`), capped by the 100 MB Worker body limit | yes | no |
| `BACKUPS_BUCKET` | no | bucket name in presigned URLs | `otinstaller-backups` | no | no |
| `ISSUES_REPO` | no | repo whose open `sev-1` issues the beta metrics count | `OTInstaller/feedback` | no | no |
| `ISSUES_TOKEN` | no | token with Issues: read, needed while that repo is private | anonymous GitHub search; a private repo answers 422 and the count is `null` with a hint | no | no |
| `EDGE_CACHE` | no | `"off"` sends every anonymous read to D1 | edge cache on (tests set `off` in `vitest.config.ts`) | no | no |

`.dev.vars.example` also sets `SITE_URL` and `API_URL` (local values `http://localhost:4321` and
`http://127.0.0.1:8787`), overriding the production vars from `wrangler.jsonc` in `wrangler dev`.

Not in `.dev.vars.example` at all: `OPS_DISPATCH_TOKEN`, `OPS_INSTALLATION_ID`, `RESEND_API_KEY`, `R2_*`,
`BACKUPS_BUCKET`, `ISSUES_REPO`, `ISSUES_TOKEN`, `EDGE_CACHE`, `SENTRY_ENVIRONMENT`, `OSINTVERSE_ISSUER`,
`GITHUB_APP_SLUG` (`OPS_REPO`, `EMAIL_FROM` and `MIRROR_HOST` come from `wrangler.jsonc` vars locally too).
Not in the `wrangler.jsonc` secrets comment: `HEALTH_TOKEN`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `ISSUES_TOKEN`,
`ISSUES_REPO`, `OSINTVERSE_ISSUER`, `BACKUPS_BUCKET`, `EDGE_CACHE`.

GitLab webhooks are not authorised by an env secret: each GitLab source has its own webhook token stored in D1.

---

## 2. `otinstaller-mirror`

`api/wrangler.mirror.jsonc`: `main: src/mirror/index.ts`, `compatibility_date: 2026-10-01`, route
`mirror.otinstaller.com` (custom domain), `limits.cpu_ms: 300000` (blob uploads are joined and hashed in the Worker).
Deploy: `npx wrangler deploy -c wrangler.mirror.jsonc`.

| Name | Kind | Required | Purpose | When unset |
| --- | --- | --- | --- | --- |
| `MIRROR` | R2 binding `otinstaller-mirror` | yes | all registry storage (`repos/...`, `uploads/...`, `hidden/...`) | – |
| `MIRROR_PUSH_TOKEN` | secret (`wrangler secret put MIRROR_PUSH_TOKEN -c wrangler.mirror.jsonc`) | for pushes | the scanner credential: HTTP Basic (any user name; the scanner uses `scanner`) at `/token` gets a 300 s admin bearer token; also signs bearer tokens (HMAC) | no push, delete or `private/` pull is possible (`adm` is forced false); anonymous public pulls still work, tokens are signed with the fixed key `anonymous-pull` |

The same token must be set as the `MIRROR_PUSH_TOKEN` secret in registry-ops. Public repos are anonymous-pull;
writes, deletes and `private/...` reads need admin. Taken-down images (`hidden/` markers) return 404 to non-admins.

---

## 3. `otinstaller-registry-web`

`web/wrangler.jsonc`: name `otinstaller-registry-web`, `compatibility_date: 2026-10-12`, routes `otinstaller.com`
and `www.otinstaller.com` (custom domains), observability on. The Cloudflare Vite plugin merges it into
`dist/server/wrangler.json` at build time. No bindings (Astro `session: false`, so no KV). Deploy: `npm run deploy`
(`astro build && wrangler deploy`).

### 3.1 Build-time and public env vars

| Name | Read in | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_API_URL` | `astro.config.mjs` (`process.env`) and `src/lib/api.ts` (`import.meta.env`) | `https://api.otinstaller.com` | API base for SSR and islands; its **origin** goes into the CSP |
| `SITE_URL` | `astro.config.mjs` (`process.env`) → Astro `site` | `https://otinstaller.com` | canonical site; `api.ts` reads it back as `import.meta.env.SITE` |
| `PUBLIC_BETA` | `src/lib/api.ts` | `"1"` | `"0"` hides the beta strip |
| `PUBLIC_ISSUES_URL` | `src/lib/api.ts` | `https://github.com/OTInstaller/feedback/issues` | where bug-report links point |

`web/.env.example` only lists `PUBLIC_API_URL` (pointing at staging); copy it to `.env.development`. These are build
inputs (Vite inlines `import.meta.env.PUBLIC_*`), not Worker runtime vars or secrets. The site has no secrets.

### 3.2 CSP link

`astro.config.mjs` computes `api = new URL(process.env.PUBLIC_API_URL ?? "https://api.otinstaller.com").origin`
and uses it in:

- `connect-src 'self' <api> https://cloudflareinsights.com`
- `img-src 'self' data: <api> https://avatars.githubusercontent.com https://gitlab.com https://secure.gravatar.com https://raw.githubusercontent.com`
- `form-action 'self' <api>`
- `script-src`: `'self'`, `https://static.cloudflareinsights.com` and the hash of `THEME_BOOT`

If the value seen by `astro.config.mjs` (shell env at build) and by `api.ts` (Vite env files) differ, browser calls
are blocked by `connect-src`. Set it the same way for both (for example in `.env.development` plus the shell, or
only via the shell for a build). The API must also list the site in its `SITE_URL` for credentialed CORS.

---

## 4. `otinstaller-get`

`ops/get/wrangler.jsonc`: name `otinstaller-get`, `main: worker.js`, `compatibility_date: 2026-10-12`, route
`get.otinstaller.com` (custom domain), observability on. Deploy with `npx wrangler deploy` from `ops/get`.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `RELEASE_REPO` | var | `OTInstaller/ot` (set in config; code falls back to the same) | repo whose latest release's scripts are served |

Behaviour (`worker.js`):

| Path | Proxies |
| --- | --- |
| `/ot`, `/ot.sh`, `/install.sh` | `https://github.com/<RELEASE_REPO>/releases/latest/download/install.sh` |
| `/ot.ps1`, `/install.ps1` | `.../install.ps1` |
| anything else | 302 to `https://otinstaller.com/docs/getting-started` |

Upstream fetches use `cf: { cacheTtl: 300, cacheEverything: true }`; responses are `text/plain; charset=utf-8`
with `cache-control: public, max-age=300`. A non-OK upstream answers 502 with a script that fails loudly (`throw
'...'` for PowerShell, `echo 'error: ...' >&2; exit 1` for sh), `cache-control: no-store`. No secrets, no bindings.

---

## 5. registry-ops GitHub Actions (`ops/workflows/*.yml`)

| Name | Kind | Workflow | Purpose | When unset |
| --- | --- | --- | --- | --- |
| `MIRROR_PUSH_TOKEN` | secret | `scan.yml` | `crane auth login <MIRROR_HOST> -u scanner`; chunked pushes of layers over 90 MB in `backup.py` | login step skipped; image backups fail at push (big layers raise immediately) |
| `MIRROR_HOST` | variable | `scan.yml` | host for the crane login | `mirror.otinstaller.com` |
| `HEALTH_TOKEN` | secret | `health.yml` | Bearer for `/v1/internal/health*`; must equal the API's `HEALTH_TOKEN` | API answers 401 and the job fails |
| `REGISTRY_API` | variable | `health.yml` | API origin (`https://api.otinstaller.com`; `/v1` appended) | `health.py` raises `KeyError` |
| `GITHUB_TOKEN` | automatic | both | `actions/checkout` | – |

`scan.yml` is triggered by `repository_dispatch` (`otinstaller-scan`, `otinstaller-backup`, `otinstaller-drill`),
so the API needs `OPS_DISPATCH_TOKEN` or the App installed on registry-ops (`OPS_INSTALLATION_ID`) with Contents:
write. `health.yml` runs on cron `0 2 * * *` and `workflow_dispatch`. Both use `permissions: contents: read`.

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

---

## 7. Cross-deployable secrets that must match

| Value | Where |
| --- | --- |
| `HEALTH_TOKEN` | API secret, registry-ops secret |
| `MIRROR_PUSH_TOKEN` | mirror Worker secret, registry-ops secret |
| `MIRROR_HOST` | API var, registry-ops variable (both default `mirror.otinstaller.com`) |
| `API_URL` / `REGISTRY_API` | API var, registry-ops `REGISTRY_API` |
| `SITE_URL` | API var (CORS), web build env |
| `PUBLIC_API_URL` | web build env, must be the API's origin |
| `OT_RELEASE_PUBLIC_KEY` | release variable, embedded in `ot` and the install scripts served by `otinstaller-get` |
