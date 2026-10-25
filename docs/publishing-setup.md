# Setting up publishing (GitHub App, OAuth apps, secrets)

Week 4 code is complete and tested against stand-ins for GitHub and GitLab. To run it for real you need
three registrations, which only the account owner can create. Use a separate set for staging.

## 1. GitHub App ("OTInstaller Registry")

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (create it under the org that will own the registry).

| Setting | Value |
| --- | --- |
| Homepage URL | `https://otinstaller.com` |
| Webhook URL | `https://api.otinstaller.com/v1/webhooks/github` |
| Webhook secret | a long random string → `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Contents: Read and write · Metadata: Read-only · Commit statuses: Read and write · Pull requests: Read and write · Workflows: Read and write |
| Organization permissions | Members: Read-only (so org membership changes reach the registry) |
| Subscribe to events | Create · Release · Push · Repository · Installation target · Organization · Membership (push, release and repository keep packages in sync; organization and membership refresh publisher profiles) |
| Where can it be installed | Any account |

Contents, Pull requests and Workflows write access are used only by the import wizard, to push the `otinstaller/import`
branch with `otinstaller.yaml` and `.github/workflows/otinstaller-release.yml` and open the pull request (GitHub refuses
to create a workflow file without the Workflows permission). Publishing itself only reads. When you add permissions to an
existing App, every installation has to accept them (Settings → Applications → the App → Review request) before the
wizard can open pull requests there; until then finishing an import answers `github_permission_required`.

If the App's URL name is not `otinstaller`, set `GITHUB_APP_SLUG` in `wrangler.jsonc` so the wizard's install links point
to `https://github.com/apps/<slug>/installations/new`.

Then generate a private key. GitHub gives a PKCS#1 key; convert it to PKCS#8 for Workers:

```bash
openssl pkcs8 -topk8 -nocrypt -in otinstaller-registry.private-key.pem -out github-app-pkcs8.pem
```

Note the App ID → `GITHUB_APP_ID`; the PKCS#8 file's contents → `GITHUB_APP_PRIVATE_KEY`.

## 2. GitHub OAuth app (sign-in)

GitHub → Developer settings → OAuth Apps → New OAuth App. Tick **Enable Device Flow** (needed by `ot login`).

- Authorization callback URL: `https://api.otinstaller.com/v1/auth/github/callback`
- Client ID → `GITHUB_CLIENT_ID`, client secret → `GITHUB_CLIENT_SECRET`

## 2a. Sign in with OSINTverse (optional)

OSINTverse is an OpenID Connect provider (issuer `https://osintverse.com/api/auth`). Register a confidential web app
on osintverse.com → Dashboard → Developer, with redirect URIs `https://api.otinstaller.com/v1/auth/osintverse/callback`
(and `http://localhost:8787/v1/auth/osintverse/callback` for local development), then:

- Client ID → `OSINTVERSE_CLIENT_ID`, client secret → `OSINTVERSE_CLIENT_SECRET` (both Worker secrets).
- Scopes `openid profile email`, authorization code with PKCE; the ID token (EdDSA) is checked for issuer, audience
  and nonce. No OSINTverse token is stored.
- `ot login --osintverse` needs no second client: the CLI gets a code from the API, the user signs in on the web at
  `/v1/auth/osintverse/device` and approves the CLI there, and the CLI receives an `ot_` token.
- Accounts are matched by OSINTverse `sub`. Nothing is linked by email: to link OSINTverse to an existing account,
  sign in with it while already signed in (Settings → Accounts). Publishing still needs GitHub or GitLab.
- Until OSINTverse approves the app, only its owner and listed testers can sign in.

## 3. GitLab OAuth application (sign-in)

GitLab.com → Edit profile (or the group) → Applications → Add new application.

- Redirect URI: `https://api.otinstaller.com/v1/auth/gitlab/callback`
- Confidential: yes · Scopes: `read_user`, `read_api` and `api`. Sign-in asks only for the first two; `api` must still
  be ticked here, because GitLab refuses any scope the application wasn't registered with ("The requested scope is
  invalid, unknown, or malformed") when a user later connects a project.
- Application ID → `GITLAB_CLIENT_ID`, secret → `GITLAB_CLIENT_SECRET`
- Device flow (`ot login --gitlab`) works with the same application.
- Connecting a project creates its webhook, which needs the `api` scope. Users grant it only when they connect:
  `POST /v1/sources/gitlab {"project": "group/name"}` answers `gitlab_scope_required` with a sign-in link that asks for it.
  Finishing an import (`POST /v1/imports/{id}/finish`) needs the same scope, for the webhook and the merge request.
- GitLab projects publish with the `.gitlab-ci.yml` that `ot init` writes: images are signed with GitLab's OIDC token
  (cosign keyless, issuer `https://gitlab.com`) and Python packages use PyPI trusted publishing. The pipeline pushes the
  release commit and tag with its job token, once the project turns on Settings → CI/CD → Job token permissions →
  "Allow Git push requests to the repository". `RELEASE_TOKEN` (a token with `write_repository`) still works instead;
  project access tokens need a paid plan on GitLab.com, so the job token is the default.

## 4. Scanner repository (registry-ops) and email

Security scans run as a GitHub Actions workflow in a private repository the registry dispatches to.

1. Create `OTInstaller/registry-ops` (private) and copy into it: `ops/scanner/scan.py` and `ops/scanner/backup.py` →
   `ops/scanner/`, and `ops/workflows/scan.yml` → `.github/workflows/scan.yml`. The same workflow runs backups and
   restore drills (section 11).
2. Starting a scan (`repository_dispatch`) needs **Contents: Read and write** on registry-ops. Pick one:
   - Recommended: a fine-grained personal access token with access to `OTInstaller/registry-ops` only and
     **Contents: Read and write** → `OPS_DISPATCH_TOKEN`. The App stays read-only on publishers' repositories.
   - Or give the App **Contents: Read and write**, install it on registry-ops and note the installation ID
     (Settings → Integrations → the app → the number in the URL) → `OPS_INSTALLATION_ID`. That permission then
     applies to every repository the App is installed on.

   When `OPS_DISPATCH_TOKEN` is set it is used; otherwise the App's installation token is.
3. Set `OPS_REPO` in `wrangler.jsonc` if the repository has another name.
4. Create a Resend API key with sending access for `otinstaller.com` (verify the domain in Resend first) →
   `RESEND_API_KEY`. Without it, emails are recorded in the `notifications` table as skipped.

To run a scan locally, exactly as CI does:

```bash
docker build -t otinstaller-scanner ops/scanner
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/request.json:/req.json" otinstaller-scanner /req.json
```

`request.json` is the `client_payload` the registry sends (see `dispatchScan` in `api/src/scans.ts`).

## 5. Secrets

```bash
cd api
npx wrangler d1 create otinstaller            # put the ID in wrangler.jsonc
npx wrangler queues create otinstaller-publish
npx wrangler r2 bucket create otinstaller-content  # rendered READMEs, guide pages and tool docs
openssl rand -base64 32                        # → TOKEN_ENC_KEY
for s in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET \
         GITLAB_CLIENT_ID GITLAB_CLIENT_SECRET TOKEN_ENC_KEY; do npx wrangler secret put $s; done
# Optional: Sign in with OSINTverse (section 2a).
for s in OSINTVERSE_CLIENT_ID OSINTVERSE_CLIENT_SECRET; do npx wrangler secret put $s; done
# Optional: URL Scanner checks of guide links (see "URL Scanner" below). Skip this line to run without them.
for s in CF_URLSCAN_ACCOUNT_ID CF_URLSCAN_TOKEN; do npx wrangler secret put $s; done
npx wrangler d1 migrations apply otinstaller --remote
npx wrangler deploy
```

For local development, copy `api/.dev.vars.example` to `api/.dev.vars` and fill it in. Use a tunnel
(for example `cloudflared tunnel --url http://127.0.0.1:8787`) as the staging app's webhook URL.

### URL Scanner (optional)

Guide releases send one link per external site to [Cloudflare URL Scanner](https://developers.cloudflare.com/radar/investigate/url-scanner/),
and a link it calls malicious rejects the release. Without these two secrets guides still publish and dead links are still
found; nothing is checked for malice (the link summary says `url_scanner: "not_configured"`).

1. `CF_URLSCAN_ACCOUNT_ID`: the Cloudflare account ID, from the dashboard URL (`dash.cloudflare.com/<account id>/...`) or the
   account's overview page. Not a secret, but kept with the token. (It is not called `CF_ACCOUNT_ID` because wrangler reads that
   name as its own account setting.)
2. `CF_URLSCAN_TOKEN`: in the dashboard, **My Profile → API Tokens → Create Token → Custom token**, add the permission
   **Account → URL Scanner → Edit**, and under Account Resources include only this account. Edit covers both calls the
   registry makes (submitting a scan, `POST /accounts/{id}/urlscanner/v2/scan`, and reading its result,
   `GET /accounts/{id}/urlscanner/v2/result/{scan id}`); this is the permission Cloudflare's URL Scanner guide asks for
   and the one the staging test ran with.
3. `npx wrangler secret put` both (the optional line above), or put them in `api/.dev.vars` for local and staging runs.

When something is wrong, releases are never blocked or held by it:

- Only one of the two set: treated as not configured.
- Token invalid, revoked or missing the permission: each submission fails with Cloudflare's error. The Worker logs
  `URL Scanner refused <url>: 401: …` (or `403`), the link is recorded as `unknown` with that reason in the guide's link
  check results (`checks.links.url_scans` in `GET /v1/guides/{ns}/{name}`, and in the review queue), and the release goes on
  as if URL Scanner were off.
- Rate limited (`429`): the remaining links wait for the next round, a minute later, for up to 5 rounds; any still not
  submitted end as `unknown` with `429: still rate limited after 5 rounds`.
- Cloudflare refuses some well-known sites (`400: url is invalid.`); those links are `unknown` too.

## 6. Import wizard

`ot import https://github.com/<owner>/<repo>` (or `https://gitlab.com/<group>/<project>`), or the API directly:

| Call | What it does |
| --- | --- |
| `GET /v1/me/repos?provider=github\|gitlab&q=` | Public repositories you administer (GitHub) or maintain (GitLab), whether the App is installed, and which are already published |
| `POST /v1/imports {"repo": url}` | Detects one repository and returns the draft manifest, what was guessed (`assumed`), and what is `missing` |
| `POST /v1/imports {"repos": [url, ...]}` | Bulk import of up to 50; detection runs in the queue (`GET /v1/imports?batch=<id>` to follow it) |
| `POST /v1/imports {"repo": url, "community": true}` | A community wrapper of a tool you don't own (anyone signed in, 10 a day; bulk for owners of `osintverse-community` and registry admins only); the upstream license must allow it |
| `PATCH /v1/imports/{id}` | `{"manifest": {...}}` sets top-level keys (null removes one), `{"yaml": "..."}` replaces the draft, `{"kind": "docker\|pipx\|guide"}` redrafts it |
| `POST /v1/imports/{id}/finish {"mode": "pr\|registry\|connect"}` | Opens the pull/merge request, keeps the manifest on the registry (owners only; publishes the newest tag right away), or connects a repository that already has `otinstaller.yaml` |
| `POST /v1/imports/{id}/finish {"mode": "submit", "dockerfile"?, "request"?}` | Finishes a community import as a submission: the community bot creates the wrapper repository and starts its release; a community reviewer approves the first one (see below) |
| `POST /v1/imports/{id}/finish {"mode": "wrapper", "wrapper_repo": url}` | Finishes a community import with a pull/merge request in a wrapper repository owned by `osintverse-community` (the manifest and a README crediting upstream, plus a release workflow when upstream publishes no image) |
| `POST /v1/packages/{ns}/{name}/sync`, `GET …/sync-log` | Sync now (10 per hour; `ot sync`) and the sync status with the last 50 events (`ot sync --log`) |
| `PUT /v1/packages/{ns}/{name}/manifest` | Edits a registry-held manifest; the next tag uses it |
| `POST /v1/packages/{ns}/{name}/manifest/pr` | Opens a pull/merge request that moves a registry-held manifest into the repository; the label goes once a tag publishes from it |

Community wrappers need the `osintverse-community` namespace: install the GitHub App on that organization (and make the
people who package tools its owners). Admins who finish with `wrapper` create one wrapper repository per tool there
first.

### Community submissions (the community bot)

Submissions from people who aren't `osintverse-community` admins go through a second GitHub App, so the registry's own
App keeps only the permissions it needs. Until it is set up, submitting answers 503 `community_bot_missing` and nothing
else changes.

1. The registry's own App must be installed on **All repositories** of `osintverse-community`, so it sees the tags of
   repositories the bot creates (the publish webhook and the 6-hourly poller both use it).
2. Create a GitHub App called "OTInstaller Community", owned by the `osintverse-community` organisation, with no
   webhook. Repository permissions: Administration, Contents, Workflows, Actions, Pull requests and Repository
   creation **read and write** (pull requests for the upstream watcher's bumps, dependency updates and maintainers'
   change proposals; GitHub now lists creating repositories as its own permission); Metadata read. Install it on
   `osintverse-community` only (all repositories). This link opens the form filled in, with the webhook off:
   `https://github.com/organizations/osintverse-community/settings/apps/new?name=OTInstaller%20Community&url=https%3A%2F%2Fotinstaller.com&public=false&webhook_active=false&administration=write&contents=write&workflows=write&actions=write&pull_requests=write&metadata=read`
   (set Repository creation by hand). Then generate a private key on the App's page.
3. Set the secrets on the API Worker (owner's step: `wrangler secret put` changes production), in `api/`:
   `printf '<app id>' | npx wrangler secret put COMMUNITY_APP_ID`;
   `openssl pkcs8 -topk8 -nocrypt -in <downloaded .pem> | npx wrangler secret put COMMUNITY_APP_PRIVATE_KEY` (the
   key as PKCS#8, like `GITHUB_APP_PRIVATE_KEY`); and `COMMUNITY_INSTALLATION_ID` the same way, from
   `gh api orgs/osintverse-community/installations` (the `otinstaller-community` row). Then delete the downloaded key;
   a new one can be generated on the App's page.
4. Grant the reviewer role to the community members who approve first releases and change proposals (Admin console,
   Community tab).
5. Check it with a throwaway submission of a small MIT tool: the bot creates `osintverse-community/<name>`, the release
   tags or builds, the version waits on `/submissions/<n>`, a reviewer approves it, and it publishes. Turn the test down
   afterwards: the repository is archived, not deleted; delete it by hand if you want it gone.

To check it against real hosts: import 5 GitHub and 5 GitLab repositories of different kinds, check that each draft is
right, then merge one pull request and one merge request, run their release workflows, and confirm the tags publish.

## 7. Check it

1. Install the app on a test repository that has a valid `otinstaller.yaml` (`ot init`), with the image pushed.
2. Push tag `v0.1.0`. Within a minute the tagged commit shows an `otinstaller/publish` status:
   *"Valid; security scans running"* (pending), or a failure naming the error code.
3. When the scan workflow in registry-ops finishes, the status becomes *"Scans passed; new publisher awaiting review"*
   and the owner gets an email.
4. `ot login`, then `ot whoami` lists the namespace as `owner, pending review`.
5. Make yourself a reviewer (`UPDATE users SET is_reviewer = 1 WHERE login = '...'` in D1), then
   `POST /v1/admin/namespaces/<ns>/approve` with your API token: the release is published, the commit status turns green,
   and `ot install <ns>/<name>` works.

## 8. Guides and tool docs

A guide is a repository with `kind: guide` in `otinstaller.yaml` (`ot init --guide` scaffolds one, with a release workflow
that sets the version and pushes the tag). Tagging it publishes it the same way as a tool, but without the scanner:

1. Validation renders every page in `content.nav` (and a tool's `docs.nav` and README) to sanitized HTML in R2. Raw
   `<script>`, `<iframe>`, forms and styles (`content_raw_html`), pages over 200 KB (`content_page_too_large`), images
   that are not PNG, JPEG, WebP or SVG files in the repository (`content_image_type`), images over 2 MB
   (`content_image_too_large`) or 50 MB in all (`content_images_too_large`), and `related_tools` that are not published
   tools (`guide_related_tool_unknown`) reject the release. `ot validate` runs the same checks locally. Images are copied
   to R2 with EXIF/XMP/text metadata removed (SVGs sanitized) and served from `/v1/assets/<sha256>.<ext>`. READMEs keep
   allow-listed layout HTML (alignment, `<details>`, badges' links); external images show their alt text.
2. The commit status says *"Valid; content checks running"* while the queue fetches every external link once (dead
   links and links to pages outside the guide are warnings; URL Scanner's malicious verdict rejects) and looks for
   personal data in examples.
3. Possible personal data holds the release for review even from an approved publisher: it shows under
   `content_review` in `GET /v1/admin/review-queue` with the lines marked, and `POST /v1/admin/versions/<id>/approve`
   or `/reject {"reason"}` decides it.
4. Every night the latest version's links are checked again; more than 20% dead marks the guide *Needs update*.

Read them with `ot guide search|read|open|get|tools` and `ot docs <ns>/<tool>`, or `GET /v1/guides/<ns>/<name>`,
`/v1/guides/<ns>/<name>/<version>/pages/<path>?format=html|md`, `/v1/tools/<ns>/<name>/docs[/<path>]`,
`/v1/tools/<ns>/<name>/guides` and `/v1/tools/<ns>/<name>/readme`.

## 9. Trust, health and operations

**Reviewers and admins.** Set `is_reviewer` (review queue, reports, takedowns, audit log) or `is_admin` (also bans and
completing claims) on a user in D1. The console is at `/admin` on the site.

**Health checks.** Generate a long random `HEALTH_TOKEN` and set it on the Worker (`wrangler secret put HEALTH_TOKEN`) and as
the secret `HEALTH_TOKEN` in registry-ops, with the repository variable `REGISTRY_API` (`https://api.otinstaller.com`).
Copy `ops/workflows/health.yml` and `ops/scanner/health.py` (with `scan.py`) into registry-ops. Every night at 02:00 UTC it
runs each tool's test input with network access; 3 failures in a row mark a tool Possibly broken, one pass clears it.

**Monitoring.** Stuck publish jobs (over 30 minutes) are emailed to admins every 15 minutes, and reviewers get a daily
digest of namespaces waiting more than 2 business days and reports older than 48 hours. Set `SENTRY_DSN` (optional) to
send server errors to Sentry with their request ID; request headers and bodies are never sent.

**Migration 0009** adds takedowns, claims and health columns: `npx wrangler d1 migrations apply otinstaller --remote`.

## 10. Releasing ot

`ot` releases come from `.github/workflows/release-cli.yml` on a `vX.Y.Z` tag, built by GoReleaser (`cli/.goreleaser.yaml`).

1. Create a **public** repository for releases (default `otinstaller/ot`; another one goes in the variables `RELEASE_OWNER` and `RELEASE_NAME`).
   The install scripts and `ot self-update` read releases from it, so keep it even though the source is public.
2. Create the release signing key, once, on a trusted machine, and keep the private key offline as well:
   ```bash
   openssl genpkey -algorithm ed25519 -out ot-release-key.pem
   openssl pkey -in ot-release-key.pem -pubout -outform DER | tail -c 32 | openssl base64 -A   # → OT_RELEASE_PUBLIC_KEY
   ```
3. In this repository's Actions settings: secret `OT_RELEASE_KEY` (the PEM), secret `RELEASE_GITHUB_TOKEN` (a token with
   contents: write on the release repository), variable `OT_RELEASE_PUBLIC_KEY`. Optional: `TAP_GITHUB_TOKEN` with write
   access to `otinstaller/homebrew-tap` and `otinstaller/scoop-bucket` (create both repositories first) for
   `brew install --cask otinstaller/tap/ot` and `scoop install ot`.
4. Push a tag `v1.0.0`. The release has archives for Windows, macOS and Linux (amd64 and arm64), deb and rpm packages,
   `checksums.txt` signed with the release key (`checksums.txt.sig`) and with cosign, and the install scripts with the
   public key filled in. Serve those scripts at `get.otinstaller.com/ot` and `get.otinstaller.com/ot.ps1`.

`ot self-update` and the install scripts refuse a release whose checksums are not signed by the key built into them.
winget, macOS notarization and Windows code signing need accounts of their own and are not set up yet.

### MCP bundles and the MCP Registry

Each release also gets one MCP Bundle per platform (`ot_<version>_<os>_<arch>.mcpb`, a one-click install for Claude
Desktop) and `server.json` for the [official MCP Registry](https://registry.modelcontextprotocol.io). The release
workflow's last step builds them with `cli/cmd/mcpb` from the binaries GoReleaser built and signed, and uploads them to
the release. `cli-install.yml` builds them from the snapshot on every PR and runs `mcpb validate`. The bundles are not
signed with `mcpb sign` yet.

Listing a release in the registry is a manual step:

1. Once: install the registry's publisher, which its docs call `mcp-publisher`
   (`go install github.com/modelcontextprotocol/registry/cmd/publisher@v1.8.1`; Go names the binary `publisher`, in
   `$(go env GOPATH)/bin`, and the commands below use that name). The registry checks that we own
   `otinstaller.com` (so the servers can be named `com.otinstaller/*`) by reading the public key the site serves at
   `/.well-known/mcp-registry-auth` (`web/public/.well-known/` in the site's repository). The matching private key is in the owner's
   `~/.mcp-registry/otinstaller.com.ed25519.hex`, outside the repository. Sign in with
   `publisher login http --domain otinstaller.com --private-key "$(cat ~/.mcp-registry/otinstaller.com.ed25519.hex)"`,
   and again if a publish says the sign-in has expired. If the key is lost, make a new pair, replace the site file, and deploy the site.
2. For each release: download its `server.json` (`gh release download vX.Y.Z --repo OTInstaller/ot --pattern
   server.json`), check it with `publisher validate server.json`, then run `publisher publish server.json`.

The registry is in preview and may change its format; `cli/cmd/mcpb` writes the 2025-12-11 schema.

## 11. Backups: the image mirror, R2 buckets and restore drills

Every published package keeps a registry-held copy, so a mistaken ban or takedown on GitHub or GitLab never breaks
installs or loses a tool's code (plan section "Source and artifact backups"):

| What | Where | Made by |
| --- | --- | --- |
| Container image of each published version, all platforms, with its signatures | `mirror.otinstaller.com/<ns>/<name>@sha256:…` (non-OSI licenses: `private/<ns>/<name>`, readable only with the push credential) | the scan job after a passing verdict: `crane copy` (same digest), then its signature, attestation and SBOM tags (`sha256-<hex>[.sig/.att/.sbom]`, and `sha256-<hex>` for cosign v3 bundles), also with crane |
| PyPI wheel of each published version | R2 `otinstaller-backups`, `wheels/<ns>/<name>/<sha256>.whl` | the scan job, through a signed upload URL |
| Git repository (all branches and tags) | R2 `otinstaller-backups`, `git/<provider>/<project_id>/<date>-<version or weekly>.bundle` | the scan job at every release, and a weekly job (Mondays 04:41 UTC) for every active source |

The registry hands the scanner short-lived signed upload URLs and a single-use token with the scan callback's answer
(or in an `otinstaller-backup` event, for weekly backups and for versions published after review), and checks what
arrived: the object exists, is within the limit (500 MB per bundle, 2 GB per image; above that the owner is emailed and
the other artifacts are kept), and a wheel matches the manifest's SHA-256. Every release bundle and the last 4 weekly
bundles are kept. Only public repositories of published packages are backed up. A removed package (any category, DMCA
included) stops being served by the mirror and the wheel route at once, and its backups are deleted 14 days later by the
nightly cron, unless an admin put it on legal hold (`POST /v1/admin/tools/<ns>/<name>/legal-hold {"hold": true, "reason": "…"}`).
Owners can turn off git backups on the dashboard (existing bundles are deleted that night); images and wheels stay
mirrored because installs depend on them.

`ot` falls back on its own: when pulling an image by digest fails with 401, 403, 404, "denied" (or Docker's "error from registry"), it pulls the same
digest from the `mirror_image` the registry returns with the manifest, and cosign verifies the same signer; when PyPI
answers 403, 404 or 410 or no longer has a file with the manifest's hash, it downloads the registry's copy (`wheel_url`)
and checks the same SHA-256. Both exist only for OSI-approved licenses. Network errors never trigger a fallback.

### What to configure

1. **R2 buckets** (the API binds both; the mirror Worker binds `otinstaller-mirror`):
   ```bash
   cd api
   npx wrangler r2 bucket create otinstaller-backups
   npx wrangler r2 bucket create otinstaller-mirror
   ```
   Neither bucket needs public access: wheels are served by the API (`/v1/tools/<ns>/<name>/<version>/wheel/<file>`)
   and images by the mirror Worker.
2. **An R2 API token for signed URLs** (recommended: without it uploads go through the API Worker, which takes at most
   100 MB per request, so bigger bundles fail). R2 → Manage R2 API tokens → Create API token, **Object Read & Write**,
   limited to `otinstaller-backups`. Then:
   ```bash
   npx wrangler secret put R2_ACCOUNT_ID         # the ID in the R2 endpoint https://<id>.r2.cloudflarestorage.com
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
   If the bucket has another name, set `BACKUPS_BUCKET` in `wrangler.jsonc`.
3. **The mirror Worker** at `mirror.otinstaller.com` (an OCI registry on R2, `api/src/mirror/`):
   ```bash
   openssl rand -base64 32                                          # → the push credential
   npx wrangler secret put MIRROR_PUSH_TOKEN -c wrangler.mirror.jsonc
   npx wrangler deploy -c wrangler.mirror.jsonc
   ```
   **DNS**: the custom domain in `wrangler.mirror.jsonc` makes Cloudflare create the record for `mirror.otinstaller.com`
   on deploy (the `otinstaller.com` zone is on the same account). Check it with `curl -i https://mirror.otinstaller.com/v2/`
   (401 with a Bearer challenge). It needs the Workers Paid plan: uploads are hashed in the Worker (`limits.cpu_ms`), and
   the scanner pushes layers over 90 MB in 50 MB chunks because request bodies are capped at 100 MB.
   `MIRROR_HOST` in `wrangler.jsonc` is the host the API puts in `mirror_image` (default `mirror.otinstaller.com`).
4. **registry-ops**: the secret `MIRROR_PUSH_TOKEN` (the same credential) and, if the mirror lives elsewhere, the variable
   `MIRROR_HOST`. The workflow installs crane and logs in to the mirror with it.
5. **Migration 0011** adds the backup tables and columns: `npx wrangler d1 migrations apply otinstaller --remote`, then
   `npx wrangler deploy` (the weekly backup and monthly drill cron triggers come with the deploy).

### Restore drill and alerts

On the 1st of each month (05:23 UTC) the registry picks a random git bundle and a random publicly mirrored image and
dispatches `otinstaller-drill`: registry-ops downloads the bundle, checks its SHA-256, clones it and pushes everything
into an empty repository, runs `git fsck` and compares refs, then pulls the image from the mirror by digest and runs
`cosign verify` with the recorded signer. A failed drill, or one that has not reported back within 6 hours, emails the
admins. Backup jobs that never report back are marked failed when their URLs expire (3 hours for releases, 12 for
weekly runs). An admin can run a drill at any time with `POST /v1/admin/backups/drill` and read the last 20 results with
`GET /v1/admin/backups/drills`.

An admin can back up a version again with `POST /v1/admin/tools/<ns>/<name>/<version>/backup`; with `{"dispatch": false}`
it returns the job instead, to run by hand: `MIRROR_PUSH_TOKEN=… python ops/scanner/scan.py job.json`.

### Restore from backup and switching the source

The owner's side is on the dashboard under **Backups** (public docs: `/docs/publishing#backups`):

1. **Restore from backup** (`POST /v1/packages/<ns>/<name>/backups/restore`, namespace owners and admins only) returns a
   one-hour download link for the latest bundle, its SHA-256, and the commands to push it to a new repository:
   `git bundle verify`, `git clone --mirror <bundle>`, `git remote set-url origin <new>`, `git push --mirror`.
2. **Switch source** (`POST /v1/packages/<ns>/<name>/source {"repo": "https://gitlab.com/group/name"}`) points the
   package at the new repository. The caller must own the package and be an admin (GitHub, with the App installed there)
   or Maintainer (GitLab, signed in with the `api` scope so the webhook can be created) of the new, public repository.
   The package keeps its name, versions and installs; the old GitLab webhook is removed; tags already in the new
   repository are recorded as a baseline and not published again; new releases must be signed by the new repository's CI.

### Check it locally

`bash scripts/e2e-backups.sh` runs the week 11 exit test on one machine: the API and the mirror under `wrangler dev`, a
local registry as the seeded `sigstore/cosign` image's original registry, and a local repository as its source. It runs
the scanner's backup jobs, blocks the original registry (403 DENIED) and removes `tldextract` from "PyPI", installs both
with `ot` (from the mirror with the signature verified, and from the wheel copy), and restores the bundle into an empty
repository standing in for the other host. It needs Docker, cosign, crane, git, Go, Node and Python.

## 12. The agent plugin (Claude Code and Cursor)

The plugin lives in `integrations/agent-plugin/` and is published as its own public repository,
`OTInstaller/agent-plugin`, so `claude plugin marketplace add OTInstaller/agent-plugin` finds `marketplace.json` at its
root. Its tests are in `cli/internal/cli/mcp_test.go` (`TestAgentPluginMatchesServer`): every tool and prompt it names
must exist in `ot mcp`.

1. Once: create the public repository `OTInstaller/agent-plugin` (Apache 2.0), empty. Done 21 Oct 2026; v0.1.0 is
   published there.
2. To publish a version: bump `version` in both `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`, then
   copy the folder's contents to the repository's root and push:
   ```bash
   git clone https://github.com/OTInstaller/agent-plugin /tmp/agent-plugin
   rsync -a --delete --exclude .git integrations/agent-plugin/ /tmp/agent-plugin/
   cd /tmp/agent-plugin && git add -A && git commit -m "Release 0.1.0" && git tag v0.1.0 && git push --follow-tags
   ```
3. Check it on a machine with Claude Code: `claude plugin validate --strict /tmp/agent-plugin`, then
   `claude plugin marketplace add OTInstaller/agent-plugin` and `claude plugin install otinstaller@otinstaller`.
4. Listings, when the plugin and `ot mcp` have been tried on real clients:
   - Anthropic's directory: submit at https://claude.ai/directory/manage (needs a paid plan). It reads the icon and
     the documentation, support, privacy and terms links from `plugin.json`.
   - The Cursor marketplace: submit the same repository (Cursor reads `.cursor-plugin/plugin.json`, `rules/`,
     `skills/` and `mcp.json`). Its review is manual.
   - The MCP Registry: as above.

Lead each submission with the consent model, the local audit log, the sandbox and the signed artifacts
(https://otinstaller.com/docs/agents). OSINT tools get extra scrutiny.
