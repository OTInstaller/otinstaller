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
| Subscribe to events | Create · Release · Push · Repository · Installation target (push, release and repository keep packages in sync) |
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

## 3. GitLab OAuth application (sign-in)

GitLab.com → Edit profile (or the group) → Applications → Add new application.

- Redirect URI: `https://api.otinstaller.com/v1/auth/gitlab/callback`
- Confidential: yes · Scopes: `read_user`, `read_api`
- Application ID → `GITLAB_CLIENT_ID`, secret → `GITLAB_CLIENT_SECRET`
- Device flow (`ot login --gitlab`) works with the same application.
- Connecting a project creates its webhook, which needs the `api` scope. Users grant it only when they connect:
  `POST /v1/sources/gitlab {"project": "group/name"}` answers `gitlab_scope_required` with a sign-in link that asks for it.
  Finishing an import (`POST /v1/imports/{id}/finish`) needs the same scope, for the webhook and the merge request.
- GitLab projects publish with the `.gitlab-ci.yml` that `ot init` writes: images are signed with GitLab's OIDC token
  (cosign keyless, issuer `https://gitlab.com`) and Python packages use PyPI trusted publishing. Add a project access
  token with `write_repository` as the CI variable `RELEASE_TOKEN` so the pipeline can push the release commit and tag.

## 4. Scanner repository (registry-ops) and email

Security scans run as a GitHub Actions workflow in a private repository the registry dispatches to.

1. Create `OTInstaller/registry-ops` (private) and copy into it: `ops/scanner/scan.py` → `ops/scanner/scan.py`,
   and `ops/workflows/scan.yml` → `.github/workflows/scan.yml`.
2. Install the GitHub App on that repository too. Add **Contents: Read and write** for it only if your org
   requires it for `repository_dispatch`; otherwise the permissions above are enough. Note the installation
   ID (Settings → Integrations → the app → the number in the URL) → `OPS_INSTALLATION_ID`.
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
| `POST /v1/imports {"repo": url, "community": true}` | A community wrapper of a tool you don't own (owners of `osintverse-community` and registry admins only); the upstream license must allow it |
| `PATCH /v1/imports/{id}` | `{"manifest": {...}}` sets top-level keys (null removes one), `{"yaml": "..."}` replaces the draft, `{"kind": "docker\|pipx\|guide"}` redrafts it |
| `POST /v1/imports/{id}/finish {"mode": "pr\|registry\|connect"}` | Opens the pull/merge request, keeps the manifest on the registry (owners only; publishes the newest tag right away), or connects a repository that already has `otinstaller.yaml` |
| `POST /v1/imports/{id}/finish {"mode": "wrapper", "wrapper_repo": url}` | Finishes a community import with a pull/merge request in a wrapper repository owned by `osintverse-community` (the manifest and a README crediting upstream, plus a release workflow when upstream publishes no image) |
| `POST /v1/packages/{ns}/{name}/sync`, `GET …/sync-log` | Sync now (10 per hour; `ot sync`) and the sync status with the last 50 events (`ot sync --log`) |
| `PUT /v1/packages/{ns}/{name}/manifest` | Edits a registry-held manifest; the next tag uses it |
| `POST /v1/packages/{ns}/{name}/manifest/pr` | Opens a pull/merge request that moves a registry-held manifest into the repository; the label goes once a tag publishes from it |

Community wrappers need the `osintverse-community` namespace: install the GitHub App on that organization (and make the
people who package tools its owners), then create one wrapper repository per tool there before finishing the import.

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
