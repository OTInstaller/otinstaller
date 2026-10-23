# Registry API reference

Derived by reading `api/src/index.ts`, `api/src/routes/*.ts`, `api/src/edge-cache.ts`, `api/src/catalog.ts`,
`api/src/env.ts`, `api/src/publish.ts`, `api/src/trust.ts` (`overLimit`), `api/src/backups.ts`, `api/src/imports.ts`,
`api/src/transfers.ts`, `api/src/scopes.ts`, `api/src/mcp.ts`, `api/src/mirror/*.ts`, `api/wrangler.jsonc` and
`api/wrangler.mirror.jsonc`. Paths are under `/v1` (Hono `basePath("/v1")`) unless stated. The public and owner routes
are also described in `spec/openapi/v1.json`, served at `/v1/openapi.json`, with each operation's token scope as
`x-scope`; a test in `api/test/api.test.ts` fails when the routes and the document disagree.

## Conventions used in the table

**Auth**

| Value | Meaning (code) |
| --- | --- |
| none | No check. `authenticate` still runs and may set `c.var.user`, which some handlers use optionally |
| user | `requireUser` (401 `unauthenticated`) |
| member | `requireMember` (`routes/sources.ts`): any role in the namespace's `namespace_members`, or `users.is_admin` (403 `forbidden`) |
| owner | Role `owner` in the namespace, or admin. Three separate implementations: inline in `sources.ts` (`/source`), `requireOwner` in `routes/imports.ts` (after `requireMember`), `requireOwner` in `routes/backups.ts` |
| own import | `requireOwnImport` (`imports.ts`): the import's `user_id`, or admin; anyone else gets 404 `import_not_found` |
| involved | `involved()` (`routes/transfers.ts`): member of the from or to namespace, the requester, a reviewer or an admin; anyone else gets 404 `transfer_not_found` |
| reviewer | `requireReviewer` (`routes/review.ts`): `is_reviewer` or `is_admin` (403 `forbidden`, "reviewers only") |
| admin | `requireAdmin` (`routes/review.ts`): `is_admin` (403 `forbidden`, "admins only") |
| scan token | `Authorization: Bearer <t>`; `sha256(t)` must equal `versions.scan_token_hash`, not expired (`SCAN_TOKEN_TTL` = 1 h), version `status = 'scanning'` |
| backup run token | Bearer; `sha256` matched to `backup_runs.token_hash`, not expired, status `pending`/`dispatched`; single use (cleared on completion). TTL 3 h for releases (`RELEASE_TTL`), 12 h weekly (`WEEKLY_TTL`) |
| drill token | Bearer; `sha256` matched to `restore_drills.token_hash`, status `dispatched`, not expired (`DRILL_TTL` = 6 h); single use |
| signed URL | Query `method`, `expires` (Unix seconds), `sig` = `objectSignature(TOKEN_ENC_KEY, method, key, expires)`; key must start with `git/` or `wheels/` and contain no `..` |
| HEALTH_TOKEN | Bearer equal to `env.HEALTH_TOKEN` (compared as SHA-256 digests); 503 `not_configured` if unset |
| HMAC | GitHub: `x-hub-signature-256` = `sha256=` + HMAC-SHA256(`GITHUB_WEBHOOK_SECRET`, raw body) |
| GitLab token | `x-gitlab-token` whose SHA-256 equals the matching source's `webhook_secret_hash` (one secret per project) |

**Token scopes** (`scopes.ts`, migration 0013). A request made with an `ot_` token whose `scoped = 1` must hold the
scope `requiredScope(method, path)` names, or `enforceScopes` answers 403 `insufficient_scope` (with
`required_scope` and a `WWW-Authenticate: Bearer error="insufficient_scope"` header). The rule, by path: `/auth/*`,
`/internal/*`, `/webhooks/*`, `/installs` and `/health` need none; `/admin*` needs `staff`; any other GET, HEAD or
OPTIONS needs `read`; `POST /feedback` and `POST /tools/:ns/:name/reports` need `feedback`; `POST /publish`,
`/imports*`, `/sources*` and `/packages/:ns/:name/manifest|sync|source*` need `publish`; every other write (including
`POST /namespaces`) needs `manage`. The session cookie,
and tokens from before 0013 (`scoped = 0`), are not limited. Every successful non-read request made with a token
writes a `token.write` audit row.

**Caching**: `cached(c, N)` writes `Cache-Control: public, max-age=N` (`catalog.ts`). It is only set on the success
path; `apiError` throws a separate response, so errors carry no `Cache-Control`. "-" means the handler sets no
`Cache-Control` at all (per-user routes are still never edge cached, because they need an `authorization` header or a
cookie, which bypasses the edge cache). Any `public` 200 with a non-zero `max-age` is stored by `edgeCached` for an
anonymous GET.

## 1. Routes

Total: **178 routes** on the registry API (`otinstaller-registry-api`), counted from every `app.get/post/put/patch/delete`
call; the `for` loops in `routes/trust.ts` (`yank`, `unyank`), `routes/community.ts` (a thread's subscription) and
`routes/requests.ts` (a vote, a request's subscription) register two each. The mirror Worker's OCI routes are in
section 6 and are not in this count. There is no route for stars, although the rate-limit comment in `index.ts`
mentions stars. Every route under a removed package answers 410 `tool_removed`.

Outside `/v1` and the Hono app, the Worker's `fetch` also answers `/mcp`: the read-only remote MCP server
(`src/mcp.ts`, sessionless Streamable HTTP; POST JSON-RPC, GET 405, `Access-Control-Allow-Origin: *`, `no-store`). Its
six tools (`search_tools`, `get_tool`, `list_types`, `suggest_pivots`, `search_guides`, `read_guide`) make anonymous GETs
to the public routes below through `edgeCached`, with none of the caller's headers. It has no rate limit of its own
in code; a Cloudflare rate-limiting rule on the zone covers `/mcp`, `/v1/tools*`, `/v1/guides*` and `/v1/pivots`
(30 requests per 10 s per IP; see the launch checklist). Protocol versions `2025-11-25`, `2025-06-18` and
`2025-03-26`; it handles `initialize`, `tools/list` and `tools/call`. Tests: `api.test.ts`, "remote MCP server".

### 1.1 Public catalog (14)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | none | - | index.ts | `{ok: true}` |
| GET | `/openapi.json` | none | `cached(c, 3600)` | index.ts | `spec/openapi/v1.json` (OpenAPI 3.1) |
| GET | `/types` | none | `cached(c, 86400)` | index.ts | Input, output and category enums from `spec/schema/v1.json`, `pivots` (`spec/pivots.json`) and `descriptions` (`spec/types.json`) |
| GET | `/tools` | none | `cached(c, 60)` | index.ts | Search. Params `q`, `input`, `output`, `category`, `runtime`, `kind`, `level`, `format`, `lang`, `sort` (relevance, installs, stars, updated, health: healthy tools by their last passing nightly check first), `no_keys`, `passive_only` (`1`/`true`: no target contact, personal data or egress), `limit` (1–100, default 25), `cursor` (offset). FTS path caps at 200 rows, non-FTS at 1000; `total_capped: true` says the total hit the cap. Summaries carry ethics and egress. A bad enum value is 400 `invalid_parameter` with the allowed values |
| GET | `/guides` | none | 60 (inherited) | index.ts | Re-dispatches internally to `/v1/tools?kind=guide` with `app.fetch`, so the `/tools` response (and its `max-age=60`) is returned |
| GET | `/tools/:ns/:name` | none | `cached(c, 60)` | index.ts | Follows aliases (`moved_to`); not found goes through `notFound()`: 410 `tool_removed` or 404 `tool_not_found`. `sample` is the latest version's passing `smoke` scan row's `sample` (entities or stdout from the test input) with `version` and `recorded_at`, when the scanner sent one |
| GET | `/tools/:ns/:name/versions` | none | `cached(c, 60)` | index.ts | Published, yanked and removed versions, semver-sorted, each with `changelog`, `changelog_html` (rendered by `changelog.ts:renderNotes`) and `changelog_source` |
| GET | `/tools/:ns/:name/:version/manifest` | none | `cached(c, version === "latest" ? 60 : 3600)` | index.ts | Removed versions return status and `removed_reason` with `manifest: null`; otherwise adds `installFallbacks()` (`mirror_image` / `wheel_url`). `manifest` is `compatManifest()` (`lib/manifest.ts`): without the optional fields added after ot v0.12, whose install-time validation rejects them; `manifest_full` carries them when anything was left out |
| GET | `/tools/:ns/:name/:version/scans` | none | `cached(c, 300)` | index.ts | PII scan summaries reduced to `{hits: <count>}` |
| GET | `/tools/:ns/:name/:version` | none | `cached(c, 3600)` | index.ts | Also 3600 for `latest` (unlike `/manifest`, which uses 60 for `latest`); carries the same release-notes fields |
| GET | `/namespaces` | none | `cached(c, 600)` | routes/profiles.ts | Publishers with a visible package (at most 500), most installed first, for the sitemap and llms.txt |
| GET | `/namespaces/:ns` | none | `cached(c, 300)` | routes/profiles.ts | The profile (`effectiveProfile()`: host values with the owner's overrides), `stats` and visible tools (with `published_at`). `pending_review` namespaces answer 200 with only the handle and host links and no tools; `rejected`/`suspended` 404 |
| GET | `/namespaces/:ns/activity` | none | `cached(c, 300)` | routes/profiles.ts | `?limit` (1–100, 30). Public audit events of visible packages: `version.published`, `version.yank`/`unyank`, `tool.deprecate`/`undeprecate`, `transfer.complete` |
| GET | `/facets` | none | `cached(c, 600)` | index.ts | How many visible packages match each facet value: `inputs`, `outputs`, `categories`, `runtimes`, `no_keys`. `kind` is tool (default) or guide; counts ignore other filters |
| GET | `/pivots` | none | `cached(c, 600)` | index.ts | `from=` comma list of entity types; follows `spec/pivots.json` to the input types each can feed (`inputs`, plus `unmapped` for types with none); top 10 non-broken tools per usable type |
| GET | `/activity` | none | `cached(c, 300)` | index.ts → activity.ts | Public events from `audit_log` (published with `new_package`/`has_notes`, yanked, unyanked, deprecated with `replacement`, undeprecated, transferred) of visible, listed packages; `limit` 1–100 (30), `before` (ms), `kind`, `input`, `namespace`, `events` (`registry` default; `community` adds `issue_confirmed`/`issue_fixed` with `number` and `issue_kind`, and `request_accepted`/`request_published` with `number` and `tool`, worded from fields; `all`); `next_before` for paging. Never carries reasons, actors or anything people wrote |
| POST | `/installs` | none | - | index.ts | `{tool, version, client?}`; 400 `invalid_body` without tool and version, else always 204 (also for unknown packages). Counts once per `cf-connecting-ip`, version and day (`overLimit` scope `install`: a salted hash of address and version in `rate_limits`, never the address itself), into `install_counts` and `install_clients` (`client` `cli`, `mcp`, `ci`, else `other`) |

### 1.2 Guides, docs, READMEs, assets, wheel copies, transparency (12)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/guides/:ns/:name` | none | `cached(c, 60)` | routes/guides.ts | Latest version of a guide; 404 `guide_not_found` if the package isn't a guide |
| GET | `/guides/:ns/:name/:version` | none | `cached(c, version === "latest" ? 60 : 3600)` | routes/guides.ts | Same handler (`detail`) |
| GET | `/guides/:ns/:name/:version/pages/:path{.+}` | none | 60 for `latest`, else 3600 | routes/guides.ts | `?format=html|md`; page by path, path without `.md`, or 1-based position |
| GET | `/assets/:file` | none | `public, max-age=31536000, immutable` (set by `imageHeaders`) | routes/guides.ts | `^[0-9a-f]{64}\.(png|jpg|webp|svg)$` from R2 `CONTENT` `assets/` |
| GET | `/tools/:ns/:name/docs` | none | `cached(c, 600)` | routes/guides.ts | Docs nav of the latest version; tools only |
| GET | `/tools/:ns/:name/docs/:path{.+}` | none | `cached(c, 600)` | routes/guides.ts | One docs page (`?format=html|md`) |
| GET | `/tools/:ns/:name/guides` | none | `cached(c, 600)` | routes/guides.ts | Guides that list this tool in `related_tools` |
| GET | `/tools/:ns/:name/readme` | none | `cached(c, 600)` | routes/guides.ts | Rendered README HTML from R2 |
| GET | `/tools/:ns/:name/:version/wheel/:file` | none | `public, max-age=86400` (set directly) | routes/backups.ts | Public wheel backup (OSI-approved licenses); `:file` is ignored, the stored filename is used |
| GET | `/removed` | none | `cached(c, 600)` | routes/trust.ts | Transparency list (`transparency()`) |
| GET | `/tools/:ns/:name/permissions` | user | `private, no-store` | routes/trust.ts | `{owner, reviewer, admin}` for the caller |
| POST | `/tools/:ns/:name/reports` | none (user optional) | - | routes/trust.ts | Report a package; rate limited (section 3); malware reports email reviewers at once |

### 1.3 Auth and device login (8)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/auth/:provider/login` | none | - | routes/auth.ts | `github`, `gitlab`, `osintverse` (else 404 `unknown_provider`); state cookie `ot_oauth_state` (600 s, path `/v1/auth`); `?redirect` (same-site only), `?scope=api` for GitLab |
| GET | `/auth/:provider/callback` | state cookie | - | routes/auth.ts | Exchanges the code, signs in or links (when already signed in with the session cookie; an `ot_` token on the callback never links: `linkingUserId`), sets `ot_session` (30 days, httpOnly, Secure, Lax), 302 |
| POST | `/auth/logout` | session cookie (optional) | - | routes/auth.ts | Deletes the session row and cookie; 204 |
| POST | `/auth/device/start` | none | - | routes/auth.ts | `{provider}` (default github); osintverse uses the registry's own device flow |
| POST | `/auth/device/token` | none (device code) | - | routes/auth.ts | `{provider, device_code, token_name, scopes?, expires_in_days?}`; on success mints a scoped `ot_` API token (default `read,publish,manage,feedback`, no expiry) and answers with its `scopes` and `expires_at`. For `osintverse` it goes to `pollOsintverseDevice` (`routes/device.ts`), which ignores `scopes` and `expires_in_days` |
| GET | `/auth/osintverse/device` | none | - | routes/device.ts | HTML code-entry form |
| POST | `/auth/osintverse/device` | none (user code) | - | routes/device.ts | Form `code`; valid pending code redirects to OSINTverse sign-in (400 HTML page otherwise) |
| POST | `/auth/osintverse/device/confirm` | one-time confirm token (form) | - | routes/device.ts | Form `id`, `confirm`, `decision`; approve or deny; 410 HTML page if expired |

### 1.4 Me (9)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/me` | user | - | routes/auth.ts | Login, admin/reviewer flags, linked accounts, namespaces with role |
| GET | `/me/tokens` | user | - | routes/auth.ts | Unrevoked API tokens, with `scopes` and `expires_at` |
| POST | `/me/tokens` | user | - | routes/auth.ts | `{name, scopes?, expires_in_days?}` (1–365, default 90); 201 with the token shown once. 400 `invalid_scope` for an unknown scope; 403 `insufficient_scope` when a token asks for more than it has, or for `staff` from anything but a reviewer's or admin's session. Audited (`token.create`) |
| DELETE | `/me/tokens/:id` | user | - | routes/auth.ts | Revoke; 204 or 404 `token_not_found`. Audited (`token.revoke`) |
| GET | `/me/publish-jobs` | user | `private, no-store` | routes/auth.ts | Last 50 jobs of the user's namespaces, found through `publish_jobs.namespace_id` (uploads), `installations` (GitHub) or `sources` (GitLab). Each has `method` (`tag`, `ci`, `direct`), `ref`, `version`, `version_status`, `scan_status`, `error_detail` and `url` |
| GET | `/me/publish-jobs/:id` | user (member of the job's namespace, else 404 `not_found`) | `private, no-store` | routes/auth.ts | One job in the same shape, plus `commit_sha` and `ci` (`{workflow, ref, sha, run}` for a CI upload); `ot publish` polls it. A CI token sees only its own repository's jobs in its namespace |
| GET | `/me/repos` | user | - | routes/imports.ts | `?provider=github|gitlab`, `?q`; GitHub admin or GitLab Maintainer+ public repos, with `published_as` |
| GET | `/me/transfers` | user | - | routes/transfers.ts | Pending, verified and accepted transfers the user is party to |
| GET | `/me/backups` | user | - | routes/backups.ts | Backup summary for up to 200 packages in the user's namespaces |

### 1.5 Webhooks (2)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/webhooks/github` | HMAC (`GITHUB_WEBHOOK_SECRET`) | - | routes/webhooks.ts | 5 MB max (413). `ping`, `installation`, `installation_repositories`, `create` (tag → `{jobId}` queued, 202), `push`, `release`, `repository` |
| POST | `/webhooks/gitlab` | GitLab token (per source) | - | routes/webhooks.ts | 5 MB max. `tag_push` (202 when queued), `release`, `push`; a bad token returns 401 `bad_signature` built by hand (no `docs`/`hint`) |

### 1.5a Publisher profiles (owner)

All need an `owner` role in the namespace (or admin), work for `active` and `pending_review` namespaces, and answer
the owner view (host values, `custom`, `effective`, About, pins, sync state, hosts, the user's accounts, packages)
with `private, no-store`. Code in `routes/profiles.ts` and `profiles.ts`.

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/me/namespaces/:ns/profile` | owner | `private, no-store` | routes/profiles.ts | The owner view |
| PATCH | `/me/namespaces/:ns/profile` | owner | `private, no-store` | routes/profiles.ts | `{custom?: {field: value or null}, about?: string or null, pins?: string[], hide_details?: bool}`; null goes back to the host value; About is rendered with `renderPage` (no raw HTML, images dropped); pins must be the namespace's packages (max 6); audited `profile.update` |
| POST | `/me/namespaces/:ns/profile/preview` | owner | `private, no-store` | routes/profiles.ts | `{about}` → `{html, problems}` |
| POST | `/me/namespaces/:ns/profile/sync` | owner | `private, no-store` | routes/profiles.ts | `syncProfile()` now; 10 per namespace per hour (429 `profile_sync_rate_limited`) |
| POST | `/me/namespaces/:ns/profile/hosts` | owner | `private, no-store` | routes/profiles.ts | `{provider, account?}`: the user's own account on that host, a GitHub org they administer or a public GitLab group they own (Owner). 400 `host_account_not_linked`, 404 `host_not_found`, 403 `host_not_owned`, 409 `host_already_primary`; 201 |
| DELETE | `/me/namespaces/:ns/profile/hosts/:provider` | owner | `private, no-store` | routes/profiles.ts | Removes a secondary host and resyncs |

### 1.6 Sources, sync and package settings (10)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/sources/gitlab` | user | - | routes/sources.ts | `{project}`; needs a linked GitLab account, Maintainer+, public project; creates the project webhook; 201 |
| DELETE | `/sources/:id` | member | - | routes/sources.ts | Deletes the GitLab webhook (best effort), pauses the source; 204 |
| POST | `/packages/:ns/:name/source` | owner (inline check) | - | routes/sources.ts | `{repo}`; switch the package to another repository (`switchSource`) |
| POST | `/packages/:ns/:name/sync` | member | - | routes/sources.ts | Manual poll; at most 10 an hour (`MANUAL_SYNC_PER_HOUR`) |
| GET | `/packages/:ns/:name/sync-log` | member | - | routes/sources.ts | Source state plus the last 50 sync events |
| PUT | `/packages/:ns/:name/manifest` | member then owner | - | routes/imports.ts | Edit a registry-held manifest (`{manifest}` or `{yaml}`); 409 `manifest_in_repo` otherwise; problems answered as 400 `manifest_invalid` |
| POST | `/packages/:ns/:name/manifest/pr` | member then owner | - | routes/imports.ts | Opens a PR/MR moving the held manifest into the repo; 201 |
| GET | `/packages/:ns/:name/backups` | owner (backups.ts `requireOwner`) | - | routes/backups.ts | `backupSummary()` |
| PATCH | `/packages/:ns/:name/backups` | owner | - | routes/backups.ts | `{git_backups: boolean}` (opt out of git backups) |
| POST | `/packages/:ns/:name/backups/restore` | owner | - | routes/backups.ts | Signed download link for the latest git bundle (`DOWNLOAD_TTL` = 3600 s) |

### 1.7 Imports (5)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/imports` | user | - | routes/imports.ts | `{repo}` or `{repos: [...]}` (at most `MAX_BULK` = 50), `{provider}`, `{community}`; 201 for one, 202 for a batch |
| GET | `/imports` | user | - | routes/imports.ts | The user's last 100 imports; `?batch` |
| GET | `/imports/:id` | own import | - | routes/imports.ts | Wizard view |
| PATCH | `/imports/:id` | own import | - | routes/imports.ts | `{manifest}` merge, `{yaml}` replace or `{kind}` rebuild |
| POST | `/imports/:id/finish` | own import | - | routes/imports.ts | `{mode: pr | registry | connect | wrapper, wrapper_repo}` |

### 1.7a Direct publishing (2)

Logic in `direct.ts`; see [architecture.md, flow a2](architecture.md#a2-publish-directly-ot-publish).

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/namespaces` | user (scope `manage`) | - | routes/direct.ts | `{name, kind?: user \| org}`; 201 `{name, kind, status: "pending_review"}`. 400 `invalid_body` / `namespace_reserved`, 409 `namespace_taken`, 403 `namespace_account_required` (a GitHub or GitLab user's name without that account linked, or an org's or group's) / `namespace_limit` (3 per user), 429 `too_many_requests` (5 a day), 503 `account_check_failed` |
| POST | `/publish` | owner or publisher of `?namespace` (scope `publish`), or a CI token for it | - | routes/direct.ts | `?namespace=&name=&version=`, body `multipart/form-data` with one part per file named by its path. Checked before the body is read: 404 `namespace_unknown`, 403 `forbidden` (also a CI token for another namespace or package) / `namespace_not_allowed`, 409 `manifest_name_taken` (for a CI token: a package another repository owns) / `manifest_version_exists` / `publish_in_progress`, 429 `publish_rate_limited` (20 an hour per namespace). Then 413 `bundle_too_large` (25 MiB, Content-Length required), 400 `bundle_invalid` (300 files, `bundlePath`, a query that doesn't match the manifest), 400 `manifest_invalid` with `problems`. 202 `{job_id, status, ref, version, url}`. With a CI token, a release already received from the same repository (a job for its `provider`, `repo_id` and tag in the namespace, queued to published) answers 200 with that job and `already_received: true` |

### 1.7b Trusted publishing (4)

Logic in `trusted.ts` and `lib/oidc.ts`; see [architecture.md, flow a3](architecture.md#a3-trusted-publishing-from-ci).

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/oidc/token` | none (the ID token) | `private, no-store` | routes/trusted.ts | `{id_token, namespace, package?}`. `verifyCiToken`: issuer `https://token.actions.githubusercontent.com` or `https://gitlab.com`, RS256 by the issuer's JWKS, `aud` `otinstaller`, `exp`/`nbf`/`iat` with 60 s leeway, lifetime at most a day, the workflow (`job_workflow_ref`, GitLab `ci_config_ref_uri`) in the repository itself (else 401 `oidc_token_invalid`; 503 `oidc_provider_unavailable` when the keys can't be fetched). 429 `too_many_requests` (30 an hour per repository id), 404 `namespace_unknown`, 403 `namespace_not_allowed`, 403 `publisher_not_trusted` (no match, a private repository, a changed repository or owner id, a risky event without an environment, the creator gone). The `jti` is unique: 401 `oidc_token_reused`. 200 `{token, expires_at, namespace, package, repository, workflow}`; the token is restricted (see section 2) |
| GET | `/me/namespaces/:ns/trusted-publishers` | owner (role `owner`) | `private, no-store` | routes/trusted.ts | `{namespace, publishers: [{id, provider, repository, workflow, environment, package, pinned, created_by, created_at, last_used_at}]}`; 404 `namespace_not_found` |
| POST | `/me/namespaces/:ns/trusted-publishers` | owner (scope `manage`) | - | routes/trusted.ts | `{provider, repository, workflow?, environment?, package?}`; repository lowercased. 400 `invalid_body`, 403 `trusted_publisher_limit` (20), 409 `trusted_publisher_exists`; 201. Audited `trusted_publisher.add` |
| DELETE | `/me/namespaces/:ns/trusted-publishers/:id` | owner (scope `manage`) | - | routes/trusted.ts | Revokes the CI tokens it minted, deletes it; 204 or 404 `not_found`. Audited `trusted_publisher.remove` |

### 1.8 Trust: yank, deprecate, claims, transfers (10)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/tools/:ns/:name/:version/yank` | member | - | routes/trust.ts | 409 `invalid_state` unless published |
| POST | `/tools/:ns/:name/:version/unyank` | member | - | routes/trust.ts | 409 `invalid_state` unless yanked |
| POST | `/tools/:ns/:name/deprecate` | member | - | routes/trust.ts | `{message (≤500), replacement?}`; replacement must exist |
| DELETE | `/tools/:ns/:name/deprecate` | member | - | routes/trust.ts | Back to `active` |
| POST | `/tools/:ns/:name/claim` | user | - | routes/transfers.ts | `{to}`; starts a claim of a community wrapper and verifies at once; 201 with `claim_token` |
| POST | `/tools/:ns/:name/transfer` | user (owner or admin checked in `offerTransfer`) | - | routes/transfers.ts | `{to: namespace}`; 201 |
| GET | `/transfers/:id` | involved | - | routes/transfers.ts | Transfer view |
| POST | `/transfers/:id/verify` | involved | - | routes/transfers.ts | Re-run claim verification |
| POST | `/transfers/:id/accept` | involved (further checks in `acceptTransfer`) | - | routes/transfers.ts | Accept a transfer |
| POST | `/transfers/:id/decline` | involved (further checks in `declineTransfer`) | - | routes/transfers.ts | Decline |

(The reports endpoint is in 1.2; the staff side of reports, removals and transfers is in 1.10.)

### 1.9 Feedback and beta, public side (1)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/feedback` | none (user optional) | - | routes/beta.ts | `{kind: bug|idea|question|other, message (3–5000), email?, page?, source: cli|web, client?}`; 201; rate limited (section 3) |

The beta's staff endpoints (`/admin/feedback`, `/admin/beta-metrics`, `/admin/email-test`) are in 1.10.

### 1.9a Community: issues, confirmations, flags, moderation (`routes/community.ts`, 23)

Logic in `community.ts`. Public reads are cached; everything a person sends is `private, no-store`. Writes by
people (`feedback` scope) go through `poster()`: a timed-out account gets 403 `posting_blocked`, daily limits answer
429 `too_many_posts`, and `holdReason()` holds posts from accounts under 24 hours old, posts `screen()` flags
(`findPersonalData`, public IPv4 addresses, token and key patterns) and a first post with links.

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/tools/:ns/:name/issues` | none | `cached(c, 60)` | routes/community.ts | `status` open (open+confirmed) / closed / all, `kind`, `before`; 30 a page; `counts`; visible posts only |
| GET | `/tools/:ns/:name/issues/:number` | none | `cached(c, 60)` | routes/community.ts | The issue and its visible comments (`renderPost`: no raw HTML or images, links `nofollow ugc`, links as text for authors under a week old); `indexable` once a maintainer replied or it was confirmed or fixed |
| GET | `/issues` | none | `cached(c, 120)` | routes/community.ts | The board: open broken, outdated and wrong_info issues across visible packages; `kind`, `needs=confirmation`, `before` |
| GET | `/tools/:ns/:name/issues/:number/viewer` | user | no-store | routes/community.ts | `can_triage`, `is_author`, `can_edit_issue`, `editable_comments`, `subscribed`, the viewer's own held comments |
| POST | `/tools/:ns/:name/issues` | user, feedback | no-store | routes/community.ts | `issueInput()`; 5 a day (2 under a week old); 201 with `number` and `moderation` |
| POST | `/tools/:ns/:name/issues/:number/comments` | user, feedback | no-store | routes/community.ts | 30 a day; locked threads 409 `issue_locked` unless the poster can triage; a triager's reply sets `maintainer_replied_at` |
| PATCH / DELETE | `/tools/:ns/:name/issues/:number` | author, feedback | - | routes/community.ts | Edit within 24 hours (409 `edit_window_closed`; re-screened) / soft delete |
| PATCH / DELETE | `/comments/:id` | author, feedback | - | routes/community.ts | Same for comments |
| PUT | `/tools/:ns/:name/confirmations` | user, feedback | no-store | routes/community.ts | `{result: works|broken, version?, platform?, engine?, ot_version?, issue?}`; one per person, version and platform; 60 a day; returns 30-day counts |
| PUT / DELETE | `/tools/:ns/:name/issues/:number/subscription` | user, feedback | - | routes/community.ts | Follow / mute a thread |
| POST | `/flags` | user, feedback | - | routes/community.ts | `target_kind` issue, comment, request or request_comment; 20 a day; a personal-data flag from an account over a week old, or three open flags, hides the target |
| POST | `/tools/:ns/:name/issues/:number/status` | triage, manage | - | routes/community.ts | Maintainers, triagers, staff; the author may set `fixed` (and reopen their own fix) |
| POST | `/tools/:ns/:name/issues/:number/lock` | triage, manage | - | routes/community.ts | `{locked}`; closed threads also lock after 30 days without activity (nightly `lockStaleThreads`) |
| POST | `/moderation/:kind/:id` | triager or staff, manage | - | routes/community.ts | `kind` issue, comment, request or request_comment; `hide`, `restore`, `approve`, `redact` (staff only; overwrites the text); maintainers may hide comments on their package's issues (requests and their replies are for triagers and staff only); resolves the target's flags |
| GET | `/moderation/queue` | triager or staff | no-store | routes/community.ts | `view=held` (held and hidden issues, comments, requests and request replies) or `flags` (open, personal data first, each with the target's site `path`, `moderation` and text as `body_html`); `before` |
| POST | `/moderation/users/:handle/timeout` | triager or staff, manage | - | routes/community.ts | Up to 7 days (`users.posting_blocked_until`) |
| GET / POST / DELETE | `/admin/community/roles[/:handle/:role]` | admin | no-store | routes/community.ts | Grant (`{handle, role: triager|reviewer, note}`, note required) and revoke; audited `role.grant`/`role.revoke` |
| POST | `/admin/reports/:id/publish-issue` | reviewer | - | routes/community.ts | A private `broken` report becomes a system issue written by the reviewer (no reporter attached); the report is actioned |

Notifications (`routes/inbox.ts`, logic in `inbox.ts`, 6 routes):

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/me/inbox` | user | no-store | routes/inbox.ts | 50 newest items with `unread` and `before` paging |
| POST | `/me/inbox/read` | user | - | routes/inbox.ts | `{ids?}`; all when none are given |
| GET / PUT | `/me/email-prefs` | user | no-store | routes/inbox.ts | `community` and `owner_issues`: `immediate` / `daily` / `off` |
| POST | `/unsubscribe` | none (signed link) | no-store | routes/inbox.ts | `u`, `s`, `t` from the query or a JSON body (RFC 8058 one-click); 400 `invalid_unsubscribe_link` |
| GET | `/unsubscribe` | none | - | routes/inbox.ts | 302 to the site's `/unsubscribe` page, which asks before posting |

Items are written by `inbox.ts:notify` with each event: new issues (to the namespace's members, scope `owner_issues`),
replies and status changes (to the thread's unmuted subscribers, scope `community`), moderation of a post and role
grants (to the person, scope `account`, always sent). The person who acted never gets one. `deliverInbox` runs on
every 15-minute cron (`immediate`, items older than 2 minutes grouped into one email per person, at most 12 a day) and
nightly (`daily` digests and anything held back); emails carry `List-Unsubscribe` and `List-Unsubscribe-Post`, and items
are marked emailed only after a send that did not fail. `purgeInbox` (nightly) drops read items after 90 days.

Internal: `fileSystemIssue(env, toolId, kind, body, dedupeKey, source)` (one issue per dedupe key; updated while open),
`closeSystemIssue`, `announceVersion` (called by `publishVersion`: "does vX fix this?" on open broken and outdated
issues) and `versionConfirmations`.

`POST /tools/:ns/:name/run-reports` (user or anonymous, `feedback`, no-store; `community.ts:reportRun`): what `ot`'s
failure prompt sends, `{version, exit_code | timed_out, os, arch, engine?, ot_version?}` and nothing else. Signed in
(20 a day) it joins the version's open broken issue as a "broken" confirmation, or opens one; anonymous (10 a day per
address) it adds to `run_signals` once per address, version and day, and 3 in a week file a system issue
(`run_signals:<version>`, "unconfirmed"). 404 `version_not_found` for an unknown version.

Tool requests (`routes/requests.ts`, logic in `requests.ts`, 13 routes):

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/requests` | none | `cached(c, 120)` | routes/requests.ts | `status` active (open, accepted, in progress) / all / one status; `sort` votes / new; `before` (`<votes>.<number>` or `<number>`); 50 a page; `counts` by status; visible requests only |
| GET | `/requests/:number` | none | `cached(c, 60)` | routes/requests.ts | With `id`, `note`, `decision_note`, `decided_by`, `dropped_reason`, `pushed_at`, `locked`, and `comments` (visible replies, oldest first, at most 500; links as text for authors under a week old); held and hidden answer 404 `request_not_found`; `indexable` once accepted |
| GET | `/requests/:number/viewer` | user | no-store | routes/requests.ts | `voted`, `is_requester`, `can_decide`, `held`, the requester's own note while held, `subscribed`, `locked`, `can_reply`, `editable_comments`, `held_comments` |
| POST | `/requests` | user, feedback | no-store | routes/requests.ts | `{repo, note?}`; 5 a day; checks below; 201 with `request`, `held`, `notes`, `url` |
| PUT / DELETE | `/requests/:number/vote` | user, feedback | no-store | routes/requests.ts | 60 a day; only open, accepted and in-progress requests (409 `request_closed`) |
| POST | `/requests/:number/status` | triager or staff, manage | no-store | routes/requests.ts | `{status, decline_code?, note?, tool?}`; `published` names the package; the requester may withdraw (`declined` + `withdrawn`); 409 `request_unchanged` |
| POST | `/requests/:number/comments` | user, feedback | no-store | routes/requests.ts | `{body}` (2 to 8000 characters); 30 replies a day, shared with issue comments; held like issue comments (`holdReason`) unless a triager or staff wrote it; 409 `invalid_state` on a held or hidden request, `request_locked` on a locked one unless a triager or staff replies; follows the request |
| PATCH / DELETE | `/requests/:number/comments/:id` | author, feedback | - | routes/requests.ts | `editPost` / `deletePost` with kind `request_comment`: 24 hours to edit (409 `edit_window_closed`), edits screened again; 404 `comment_not_found` for a reply on another request |
| PUT / DELETE | `/requests/:number/subscription` | user, feedback | - | routes/requests.ts | Follow, or mute (`request_subscriptions.muted`) |
| POST | `/requests/:number/lock` | triager or staff, manage | - | routes/requests.ts | `{locked}` (default true); 403 `not_triager` |

`createRequest` checks, in order: `parseRepoRef` (400 `invalid_body`); an existing request for the repository (409
`request_exists` with `number` and `status`; a withdrawn one is reopened as the new person's instead); `readUpstream`
through `deps.fetch` with 5 s per step (503 `upstream_unreachable`), as the requester (their GitHub or GitLab token),
else the GitHub App's installation on `osintverse-community`, else anonymously: 404 `repo_not_found` /
`project_not_found`, 400 `repo_not_public`; the same request under its project ID (renames); a published package from
the repository or a wrapper whose manifest `homepage` is it (409 `already_in_registry` with `ref`); an
`otinstaller.yaml` upstream (409 `upstream_has_manifest`). A license `isRedistributable` refuses (read from the
LICENSE file when GitHub says NOASSERTION) or an archived repository is recorded as `declined` at once. `knownRepo`
(generated `known-repos.ts`) adds `otlite_name` and the seed survey's `dropped_reason`. Requests from accounts under
24 hours old, or whose note `screen()` flags, are `held` and appear in `/moderation/queue?view=held` as kind
`request`; `/moderation/request/:id` approves, hides, restores or (staff) redacts the note, and settles its flags.
`setRequestStatus` notifies the people following the request (the requester, people who replied or followed it) on
every change and voters on published or declined (inbox, scope `community`); replies notify the followers too.
`lockStaleThreads` (nightly) locks published and declined requests 30 days after `updated_at`, which replies move;
`linkPublished` (called by `publishVersion`) marks requests for the package's own repository or the upstream its
`homepage` names as published.

Community submissions (`routes/submissions.ts`, logic in `submissions.ts`, 9 routes; submitting is
`POST /imports/:id/finish {mode: "submit", dockerfile?, request?}` in `routes/imports.ts`):

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/submissions` | none | `cached(c, 120)` | routes/submissions.ts | `status` open / published / closed / all, `before` (number); 50 a page |
| GET | `/submissions/:number` | none | `cached(c, 60)` | routes/submissions.ts | Manifest, Dockerfile, `template_conformant`, `flags`, `dockerfile_checks`, the latest release with its scans, decision, reviewer |
| GET | `/submissions/:number/viewer` | user | no-store | routes/submissions.ts | `is_submitter`, `can_review`, `can_edit` |
| PUT | `/submissions/:number` | submitter, publish | no-store | routes/submissions.ts | `{manifest?, dockerfile?}` while submitted, sent back or failed: checked again, committed, released again (patch bump when the version was tagged) |
| POST | `/submissions/:number/withdraw` | submitter, manage | - | routes/submissions.ts | Archives the wrapper repository |
| POST | `/submissions/:number/start` | reviewer, manage | - | routes/submissions.ts | Starts the build of a non-conformant Dockerfile |
| POST | `/submissions/:number/approve` | reviewer, manage | - | routes/submissions.ts | Publishes the release waiting for review; 403 `self_review` for the submitter, `not_reviewer` without the role |
| POST | `/submissions/:number/request-changes` / `reject` | reviewer, manage | - | routes/submissions.ts | `{note}` required; turns the waiting release down; reject archives the repository and puts a linked request back to accepted |

`submitWrapper` refuses without the community bot's secrets (503 `community_bot_missing`), with three open submissions
(409 `too_many_submissions`), on draft problems (409 `import_not_ready`), a builds-image draft without a Dockerfile
(400 `dockerfile_required`) and on any blocking check, as 409 with all of them in `problems`:
`license_not_redistributable`, `license_mismatch`, `upstream_has_manifest`, `already_packaged`, `submission_exists`,
`name_taken`, `pypi_not_upstream`, `dockerfile_too_large`. `dockerfileChecks` (base image, non-root user, `ADD` URL,
piped shell, a pin `upstream-pin.ts:findPin` can read) only decide `template_conformant`; flags for reviewers are
`similar_name`, `stale_upstream`, `few_stars`, `dropped_in_survey`, `archived_upstream`, `pypi_unchecked`. Then the
bot (`COMMUNITY_*`) creates the repository, commits the files, a `sources` row links it (`connected_by` the submitter,
the main App's installation on the namespace), and the release starts: `createTag` for pinned images and wheels, a
`workflow_dispatch` of `otinstaller-release.yml` for conformant builds. In the pipeline: `record()` marks a new tool
from that repository `needs_first_review` (`markSubmittedTool`), `applyScanResults` holds it in `awaiting_review`
even in an active namespace (`firstReleaseScanned`), and `publishVersion` clears the flag and adds the submitter to
`tool_maintainers` (`firstReleasePublished`). `/admin/versions/:id/approve` also refuses the submitter
(`self_review`). `GET /tools/:ns/:name` gains `packaged_by` and `maintainers`. `POST /imports {community: true}` is open
to anyone signed in (10 a day); bulk community imports stay with admins.

The upstream watcher (`routes/upstream.ts`, logic in `upstream.ts`, 4 routes; the nightly cron queues
`{upstreamCheckToolId}` for every published community wrapper with an `upstream_url`):

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/upstream/summary` | none | `cached(c, 3600)` | routes/upstream.ts | `mode` (report, issues, prs), `counts` by state, `behind` (release pins only), `checked_at` |
| GET | `/admin/upstream` | reviewer | no-store | routes/upstream.ts | Every watch row (`state` filter), with pin kind, license, error and override |
| PUT | `/admin/upstream/:ns/:name` | admin | no-store | routes/upstream.ts | `{pinned, pin_kind?, package?}` override or `{clear: true}`; audited `upstream.override`; checks at once |
| POST | `/admin/upstream/:ns/:name/check` | reviewer | no-store | routes/upstream.ts | Checks now |

`checkUpstream` reads the upstream repository (gone → `gone`, a different `full_name` → `renamed`, `archived`, a
license `isRedistributable` refuses → `license_changed`), then the pin: a staff override, the pipx manifest's
`package_version`, the Dockerfile at the version's `git_sha` (`upstream-pin.ts:findPin`; read again only when
`latest_version_id` changes), or the manifest version for wrappers of upstream's own image. Then upstream's latest:
PyPI JSON for pip and pipx pins; for commit pins the compare API (`commits_behind`); otherwise
`releases/latest` with `If-None-Match` (a 304 keeps the stored answer) or, with no releases, the highest tag.
`compareVersions` decides `behind` or `current`; names it can't compare are `unknown`. GitHub calls use the registry
App's installation on `osintverse-community` (anonymous without one). With `UPSTREAM_WATCH=issues`, `actOn` files
`outdated` system issues (dedupe `outdated:<release>`, three days after the release, older ones closed as superseded,
closed as fixed when the pin catches up) and one per upstream change (`upstream:<state>`), and tells admins about a
license that no longer allows redistribution. `GET /tools/:ns/:name` gains `upstream` (`publicWatch`, plus `bump`).

Bump pull requests (`bumps.ts`, 2 routes in `routes/upstream.ts`): with `UPSTREAM_WATCH=prs` (issues mode plus this)
and the community bot set up, `maybeOpenBump` opens `otinstaller/bump-<release>` in the wrapper repository three days
after a release, once per release (`bump_prs`; an older open one is closed), changing only the pin: the Dockerfile
line `findPin` points at, or the pipx manifest's `version`, `package_version` and `wheel_sha256` (from PyPI). Commit
pins and wrappers of upstream's own image get none.

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/packages/:ns/:name/bump` | user | no-store | routes/upstream.ts | The open bump (`version`, `number`, `url`) and `can_release` |
| POST | `/packages/:ns/:name/pulls/:number/release` | maintainer or reviewer, publish | no-store | routes/upstream.ts | `releaseBump`: 403 `not_package_maintainer`; a pull request whose files aren't `pinOnly` needs a reviewer (403 `not_pin_only`); squash-merges (409 `bump_not_mergeable`), then dispatches the release workflow with upstream's version (a patch on top when it exists) or tags `v<version>` for wheels |

Maintainers are `tool_maintainers` rows (the submitter, others staff add) and the namespace's members;
`community.ts:roleBadge` now gives tool maintainers the maintainer badge, so they triage the package's issues, and
`inbox.ts:maintainers` sends them its new issues.

Contributor profiles (`routes/people.ts`, logic in `people.ts`, 2 routes):

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/people/:handle` | none | `cached(c, 300)` | routes/people.ts | Handle (case-insensitive), avatar, `joined` (YYYY-MM), `roles` (`staff`, else `triager`/`reviewer`), `counts` from `contributor_stats`, `counted_at`, the 10 newest visible issues and requests, `indexable` (a role, a confirmed or fixed report, a published request or triage); hidden, banned and unknown people 404 `person_not_found`; never email, login or accounts |
| PUT | `/me/community-profile` | user, manage | no-store | routes/people.ts | `{hidden}` sets `users.profile_hidden` (also on `/me` as `profile_hidden`); audited `profile.hide` / `profile.show` |

`refreshContributorStats` recounts everyone who took part on the nightly cron, with one `INSERT OR REPLACE ... SELECT`
over the author indexes from 0019.

### 1.10 Admin and staff (24)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/admin/review-queue` | reviewer | - | routes/review.ts | Pending namespaces with their waiting versions, plus `content_review` (held releases of active namespaces) |
| POST | `/admin/namespaces/:ns/approve` | reviewer | - | routes/review.ts | `{notes?}`; activates and queues `{publishVersionId}` per waiting version (batches of 100) |
| POST | `/admin/namespaces/:ns/request-changes` | reviewer | - | routes/review.ts | `{notes}` required; closes waiting versions as `changes_requested`, emails owners |
| POST | `/admin/namespaces/:ns/reject` | reviewer | - | routes/review.ts | `{reason}` required; failure commit statuses, email |
| POST | `/admin/versions/:id/approve` | reviewer | - | routes/review.ts | Held release of an active namespace; publishes at once (`publishVersion`) |
| POST | `/admin/versions/:id/reject` | reviewer | - | routes/review.ts | `{reason}` required |
| POST | `/admin/namespaces/:ns/verify` | admin | - | routes/review.ts | Sets `verified = 1` |
| POST | `/admin/namespaces/:ns/suspend` | admin | - | routes/review.ts | `{reason}` required |
| GET | `/admin/reports` | reviewer | - | routes/trust.ts | `?status=open|actioned|dismissed|all` (default open); malware first; ≤200 |
| POST | `/admin/reports/:id/resolve` | reviewer | - | routes/trust.ts | `{status: actioned|dismissed, action, note}` |
| POST | `/admin/tools/:ns/:name/:version/remove` | reviewer | - | routes/trust.ts | `{category, reason, suspend_namespace?}`; remove one version |
| POST | `/admin/tools/:ns/:name/remove` | reviewer | - | routes/trust.ts | Remove the whole package |
| POST | `/admin/users/:login/ban` | admin | - | routes/trust.ts | `{reason}`; deletes sessions, revokes tokens; refuses admins (409 `cannot_ban_admin`) |
| GET | `/admin/audit-log` | reviewer | - | routes/trust.ts | `?before` (ms), `?limit` (1–500, default 100) |
| GET | `/admin/transfers` | admin | - | routes/transfers.ts | `?status` (default `verified`, or `all`); ≤200 |
| POST | `/admin/transfers/:id/complete` | admin | - | routes/transfers.ts | Completes a transfer |
| GET | `/admin/feedback` | reviewer | `private, no-store` | routes/beta.ts | `?status=open|done|dismissed|all`; bugs first; ≤200 |
| POST | `/admin/feedback/:id/resolve` | reviewer | - | routes/beta.ts | `{status: done|dismissed|open, note?}` |
| GET | `/admin/beta-metrics` | reviewer | `private, no-store` | routes/beta.ts | Publishers by host, packages, installs, failed publishes (7 d), open feedback, open sev-1 issues, exit criteria |
| POST | `/admin/email-test` | admin | - | routes/beta.ts | Test email to the caller via Resend; 502 with the error on failure |
| POST | `/admin/backups/drill` | admin | - | routes/backups.ts | Runs `startDrill` now; 202 when dispatched |
| GET | `/admin/backups/drills` | admin | - | routes/backups.ts | Last 20 drills |
| POST | `/admin/tools/:ns/:name/legal-hold` | admin | - | routes/backups.ts | `{hold: boolean, reason}` (reason required to set) |
| POST | `/admin/tools/:ns/:name/:version/backup` | admin | - | routes/backups.ts | `releasePlan(..., "manual")`; `{dispatch: false}` returns the job instead of sending it |

### 1.11 Internal (7)

| Method | Path | Auth | Caching | Defined in | Notes |
| --- | --- | --- | --- | --- | --- |
| POST | `/internal/scans` | scan token | - | routes/review.ts | Scanner callback; body ≤256 KB (`MAX_RESULTS`), shape-checked by `parseResults`; answers `{status, verdict, backup?}` |
| PUT | `/internal/backups/objects/*` | signed URL (`method=PUT`) | - | routes/backups.ts | Upload when R2 credentials are unset; needs `Content-Length`; limit by prefix (`git/` `MAX_BUNDLE_BYTES`, `wheels/` `MAX_WHEEL_BYTES`) |
| GET | `/internal/backups/objects/*` | signed URL (`method=GET`) | - | routes/backups.ts | Download (restores, drills) |
| POST | `/internal/backups/:run` | backup run token | - | routes/backups.ts | `{items: [...]}` at most 10, status `stored|too_large|failed`; `completeRun` |
| POST | `/internal/drills/:id` | drill token | - | routes/backups.ts | `{result, detail, checks}`; `completeDrill` |
| GET | `/internal/health/targets` | HEALTH_TOKEN | - | routes/ops.ts | `healthTargets()` for the nightly health workflow |
| POST | `/internal/health` | HEALTH_TOKEN | - | routes/ops.ts | `{results: [...]}` at most 500; `applyHealth()` |

Per-area sums: 12 + 12 + 8 + 8 + 2 + 10 + 5 + 10 + 1 + 24 + 7 = **99**. (There is no separate "ops/health" public route; the
health endpoints are the two internal ones above.)

## 2. Middleware and handler order (`index.ts`)

Order in which things are registered on the Hono app (Hono runs matched handlers in registration order, and a route
handler that returns ends the chain):

1. **CORS** (`app.use("*")`, index.ts lines 36–41). Methods `GET, POST, PATCH, PUT, DELETE`. If the request's `Origin`
   header is exactly `c.env.SITE_URL` (`https://otinstaller.com` in `wrangler.jsonc`), it gets
   `cors({ origin: SITE_URL, credentials: true })`; every other origin (including none) gets `cors({ origin: "*" })`
   without credentials. Note that `https://www.otinstaller.com` is not equal to `SITE_URL`, so it gets the
   uncredentialed `*` answer.
2. **`authRoutes(app)`**, which first registers `app.use("*", authenticate)` and `app.use("*", enforceScopes)`, then
   `deviceRoutes(app)` and all `/auth/*` and `/me*` routes of `auth.ts`. `authenticate` never rejects: a
   `Bearer ot_...` token is looked up by SHA-256 in `api_tokens` (not revoked, not expired, user not banned;
   `last_used_at` updated via `waitUntil`; `lib/tokens.ts:findToken`, shared with the mirror) and sets `c.var.token` (`id`, `scopes`, `scoped`, `restriction`); otherwise the `ot_session` cookie is looked up in `sessions`. Non-`ot_` bearer tokens (scan, backup,
   health) leave `user` null. A CI token (a row with `namespace_id`, minted by `POST /auth/oidc/token`) counts only on
   `POST /publish` and `GET /me/publish-jobs/:id` (`restrictedRouteAllowed`); anywhere else the request is anonymous.
   Its writes are audited with `actor_kind` `github` or `gitlab`. `enforceScopes` is described under [Conventions](#conventions-used-in-the-table).
3. **Write rate limit** (`app.use("*")`, lines 45–52): when there is a user who is neither `is_reviewer` nor
   `is_admin`, and the method is not `GET`, `HEAD` or `OPTIONS`, `overLimit(env, "write", user.id, 30, 60_000)`; over
   the limit throws 429 `too_many_requests` ("at most 30 changes a minute", with `Retry-After`, `RateLimit-Policy`
   and `retry_after_s` from `rateLimited`). Because it is registered *after*
   `authRoutes`, the auth and device routes and `POST /me/tokens`, `DELETE /me/tokens/:id`, `POST /auth/logout`,
   `/auth/device/*`, `/auth/osintverse/device*` are **not** covered, even though the comment lists "tokens".
   Anonymous writes (installs, feedback, reports) are not covered either.
4. Route registrars, in this order: `webhookRoutes`, `reviewRoutes`, `sourceRoutes`, `importRoutes`, `guideRoutes`,
   `trustRoutes`, `transferRoutes`, `opsRoutes`, `betaRoutes`, `backupRoutes`, `profileRoutes`, `directRoutes`,
   `trustedRoutes`. `POST /auth/oidc/token` is anonymous, so the write limit doesn't apply to it; it has its own (section 3).
5. `app.onError`: an `HTTPException` (every `apiError`) returns its own response. Anything else: request ID =
   `cf-ray` header or a new ULID, `reportError` to Sentry via `waitUntil`, `console.error`, and
   `500 {error: {code: "internal_error", message: "Something went wrong on our side.", hint, docs, request_id}}`.
6. `app.notFound`: `404 {error: {code: "not_found", message: "No such endpoint.", hint: "the API reference is at
   /v1/openapi.json", docs}}`.
7. The public catalog endpoints of `index.ts` (section 1.1), registered last at module level.

**Registration-order constraints**

- `guideRoutes` must come before the `index.ts` route `GET /tools/:ns/:name/:version`, which would otherwise take
  `/tools/:ns/:name/docs`, `/guides` and `/readme` (comment on line 57). The same applies to
  `GET /tools/:ns/:name/permissions` (trust.ts), which is safe because all registrars run before the `index.ts`
  endpoints. `GET /tools/:ns/:name/versions` is declared before `/:version` within `index.ts`.
- The write rate limiter must come after `authenticate` (it reads `c.get("user")`), which is why `authRoutes` is
  registered first; the side effect is the exemption described in step 3.

**Default export** (`index.ts` lines 378–406):

- `fetch`: `/mcp` goes to the remote MCP server (`mcpEndpoint` in `mcp.ts`) first; everything else is
  `edgeCached(req, env, ctx, () => app.fetch(req, env, ctx))`. Every successful GET with a JSON or text body gets a
  weak `ETag` (a hash of the body), and a matching `If-None-Match` gets a 304, cached or signed in. `edgeCached` (`edge-cache.ts`) bypasses the
  cache when `env.EDGE_CACHE === "off"`, the method isn't `GET`, or the request has an `authorization` or `cookie`
  header. The key is the URL with sorted query params plus `__cors=site|any` (site when `Origin === SITE_URL`). It
  stores only `200` responses whose `Cache-Control` contains `public` and a non-zero `max-age`, and no `set-cookie`,
  via `caches.default.put` in `waitUntil`; the original header is saved in `x-ot-cache-control`. On a hit it restores
  `cache-control` from that header, removes it, and adds `x-edge-cache: hit`. There is no purge. The `/guides` alias
  calls `app.fetch` directly, so its inner `/tools` request is not separately edge cached (the outer `/guides` GET is).
- `queue`: `handleBatch` (section 4).
- `scheduled`: section 5.

## 3. Other rate limits and size limits

`overLimit(env, scope, who, limit, windowMs)` (`trust.ts`): fixed windows (`floor(now / windowMs) * windowMs`), key =
first 32 hex chars of `sha256("${TOKEN_ENC_KEY ?? "ot"}|scope|who")`, counter upserted in `rate_limits`; over when the
count is greater than `limit`. Windows older than a day are deleted nightly by `purgeRateLimits`.

| What | Limit | Scope / key | Error | Where |
| --- | --- | --- | --- | --- |
| Writes by signed-in non-staff users | 30 per 60 s | `write` / user id | 429 `too_many_requests` | index.ts |
| Reports, signed in | 20 per 86 400 000 ms (day) | `report-user` / user id | 429 `too_many_reports` | routes/trust.ts |
| Reports, anonymous | 5 per 3 600 000 ms (hour) | `report-ip` / `cf-connecting-ip` (or `"unknown"`) | 429 `too_many_reports` | routes/trust.ts |
| Install pings | 1 per day per address and version (extra pings answer 204 and are not counted) | `install` / `cf-connecting-ip` + version id | none (204) | index.ts |
| Feedback, signed in | 10 per hour | `feedback-user` / user id | 429 `too_many_requests` | routes/beta.ts |
| Feedback, anonymous | 10 per hour | `feedback-ip` / `cf-connecting-ip` | 429 `too_many_requests` | routes/beta.ts |
| Manual sync | 10 per rolling hour per source (`MANUAL_SYNC_PER_HOUR`), counted from `sync_events` with `kind = 'manual'` | source | 429 `sync_rate_limited` | routes/sources.ts |
| OSINTverse device poll | `interval` 5 s; a poll less than 4 s (`(INTERVAL - 1) * 1000`) after the last answers `slow_down` (not an error) | device login | `{status: "slow_down"}` | routes/device.ts |
| OSINTverse device code | TTL 10 min; rows expired more than 24 h are deleted on each start | | | routes/device.ts |
| GitHub/GitLab device flow | whatever the provider says (`pending`, `slow_down`, ...) is passed through | | | routes/auth.ts |
| Claims and transfers | no rate limit found in `routes/transfers.ts` or `transfers.ts` (only the global write limit) | | | |
| Bulk imports | at most 50 repositories per request (`MAX_BULK`) | | 400 `too_many_repos` | routes/imports.ts |
| Uploads (`ot publish`) | 20 per hour per namespace (`PUBLISHES_PER_HOUR`); 25 MiB and 300 files per upload | `publish` / namespace id | 429 `publish_rate_limited`; 413 `bundle_too_large`; 400 `bundle_invalid` | direct.ts |
| Registry namespaces | 3 per user (`MAX_NAMESPACES_PER_USER`, counted by `created_by`); 5 attempts a day | `namespace_create` / user id | 403 `namespace_limit`; 429 `too_many_requests` | direct.ts |
| CI token exchanges | 30 per hour per repository (`EXCHANGES_PER_HOUR`); each ID token once (`api_tokens.jti` unique) | `oidc_token` / `<provider>:<repository id>` | 429 `too_many_requests`; 401 `oidc_token_reused` | trusted.ts |
| Trusted publishers | 20 per namespace (`MAX_PUBLISHERS`) | | 403 `trusted_publisher_limit` | trusted.ts |
| Webhook bodies | 5 MB (`MAX_BODY`) | | 413 `payload_too_large` | routes/webhooks.ts |
| Scan results | 256 KB by `Content-Length` (`MAX_RESULTS`) | | 413 `payload_too_large` | routes/review.ts |
| Health results | at most 500 per call | | 400 `invalid_body` | routes/ops.ts |
| Backup report items | at most 10 per call | | 400 `invalid_body` | routes/backups.ts |
| Signed backup uploads | by key prefix: `MAX_BUNDLE_BYTES` (`git/`), `MAX_WHEEL_BYTES` (`wheels/`) | | 413 `too_large` | routes/backups.ts |
| Sync polling | at most 3 tags queued per poll (`MAX_TAGS_PER_POLL`), 50 sources per cron run, every 6 h per source (`POLL_INTERVAL`) | | | sync.ts |

## 4. Queue messages (`PublishMessage`, `env.ts`) and `handleBatch` (`publish.ts`)

Queue `otinstaller-publish`, producer binding `PUBLISH_QUEUE`. Consumer settings in `wrangler.jsonc`:
`max_batch_size: 5`, `max_retries: 5`, `retry_delay: 30`.

| Message | Handler in `handleBatch` | Produced by (examples) |
| --- | --- | --- |
| `{ importId }` | `detectQueued(env, importId)` (imports.ts) | bulk imports |
| `{ checkVersionId, attempt? }` | `runContentChecks(env, checkVersionId, attempt ?? 0)` (guides.ts) | guide content checks; `attempt` counts URL Scanner rounds |
| `{ linkCheckToolId }` | `recheckLinks(env, linkCheckToolId)` (guides.ts) | `queueNightlyLinkChecks` (batches of 100) |
| `{ publishVersionId }` | `publishApproved(env, publishVersionId)` (publish.ts): publishes only if the version is `awaiting_review` and the namespace is `active` | `POST /admin/namespaces/:ns/approve` (batches of 100) |
| `{ backupVersionId }` | `backupVersion(env, backupVersionId)` (backups.ts) | versions published without a scanner run (approvals, guides) |
| `{ profileNamespaceId }` | `syncProfile(env, id)` (profiles.ts); never throws, failures are recorded on the profile | a new namespace (GitHub App installation, GitLab connect); GitHub `organization` and `membership` webhooks |
| `{ mirrorSweepRepo }` | `sweepMirrorRepo(env, repo)` (backups.ts): `sweepRepo` keeping the package's non-rejected versions' digests and its backups, then drops push records older than a week | `queueMirrorSweeps`, nightly (50 repositories) |
| `{ jobId }` (the `else` branch) | `processJob(env, jobId)` (publish.ts) | GitHub `create` webhook, GitLab `tag_push`, poller, imports, uploads (`POST /publish`) |

Dispatch is by `"key" in body`, in the order `importId`, `checkVersionId`, `linkCheckToolId`, `publishVersionId`,
`backupVersionId`, `profileNamespaceId`, `mirrorSweepRepo`, else `jobId`. Messages are processed one after another and acked individually.

**Retry**: on an exception, `transient = !(e instanceof HostError) || e.transient`. If transient and
`msg.attempts < 5`, `msg.retry({ delaySeconds: 30 * msg.attempts })` (30, 60, 90, 120 s). Otherwise (non-transient
`HostError`, or the 5th attempt): `importId` → `failImport(env, id, "detection_failed", message)`; `jobId` →
`failJob(env, jobId, message)` (job `status = 'error'`, `error_code = 'internal_error'`, only from
queued/validating or an undispatched scan); every other kind is only `console.error`'d; then `msg.ack()`. So a message
gets at most 5 deliveries (4 retries); the wrangler `max_retries: 5` would allow one more, but the code acks first. The
code's backoff overrides the wrangler `retry_delay: 30`. `HostError.transient` is set for status ≥500 or 429 (and for
GitHub 403 rate-limit bodies).

## 5. `scheduled()` and crons

`wrangler.jsonc` `triggers.crons`: `"17 3 * * *"`, `"*/15 * * * *"`, `"41 4 * * 1"`, `"23 5 1 * *"`.

`scheduled` has no guard on the first block, so **every** trigger (including the nightly, weekly and monthly ones) runs:

1. `expireStaleScans(env)` (scans.ts): versions still `scanning` past `scan_token_expires_at` (1 h) become `rejected`
   (`scan_timeout`), their jobs `error`/`scan_timeout`.
2. `pollDueSources(env)` (sync.ts): up to 50 sources in `ok`, `error` or `unavailable` not polled for 6 h.
3. `alertStuckJobs(env)` (ops.ts): jobs unfinished after 30 min, each reported once.
4. `expireRuns(env)` (backups.ts): backup runs past `expires_at` become `expired`.
5. `expireDrills(env)` (backups.ts): dispatched drills past 6 h finish as `expired`.
6. `backfillBackups(env)` (backups.ts): up to `BACKFILL_PER_RUN` = 5 published versions with no image/wheel backup,
   at most once a day each.
7. `deliverInbox(env, "immediate")` (inbox.ts): inbox items older than 2 minutes, grouped into one email per person who
   asked for them at once (at most 12 community emails a day).

`refreshDueProfiles(env)` (profiles.ts) also runs in this block, between the source poll and the stuck-job alert.

Then, by `event.cron`:

| Cron | Constant | Extra work |
| --- | --- | --- |
| `*/15 * * * *` | | none beyond the block above |
| `41 4 * * 1` (Mondays 04:41 UTC) | `WEEKLY_BACKUP_CRON` (backups.ts) | `weeklyBackups(env)`: a git backup of every active source, dispatched 20 per call (`WEEKLY_PER_DISPATCH`) |
| `23 5 1 * *` (1st of the month 05:23 UTC) | `RESTORE_DRILL_CRON` (backups.ts) | `startDrill(env)`: restore a random git bundle and pull a random public mirrored image |
| `17 3 * * *` (daily 03:17 UTC) | literal string in index.ts | `queueNightlyLinkChecks(env)`, `dailyDigest(env)` (namespaces waiting > 2 business days, reports > 48 h), `purgeRateLimits(env)` (windows older than a day), `purgeBackups(env)` (due deletions, except legal holds), `purgeIdleNamespaces(env)` (direct.ts: registry namespaces still pending with no package 30 days after creation, 50 a night), `purgeCiTokens(env)` (trusted.ts: CI tokens expired more than two days, `CI_TOKEN_RETENTION`), `lockStaleThreads(env)` (closed issues quiet for 30 days), `deliverInbox(env, "daily")` (digests), `purgeInbox(env)` (read items after 90 days, all after a year), `refreshContributorStats(env)`, `queueUpstreamChecks(env)` (`{upstreamCheckToolId}` per community wrapper), `queueMirrorSweeps(env)` (backups.ts: `{mirrorSweepRepo}` for up to 50 mirror repositories with publisher pushes older than a week, and `purgeUploads` for blob uploads idle a day), then the SQL `UPDATE tools SET installs_30d = ...` over the last 30 days of `install_counts` |

## 6. Mirror Worker (`otinstaller-mirror`)

Config `wrangler.mirror.jsonc`: `main: src/mirror/index.ts`, custom domain `mirror.otinstaller.com`, R2 binding
`MIRROR` (`otinstaller-mirror`, also bound by the API), D1 binding `DB` (the API's `otinstaller`: publishers' tokens,
namespaces and `mirror_pushes`), `limits.cpu_ms: 300000`. Secret: `MIRROR_PUSH_TOKEN`. The
entry (`index.ts`) wraps `mirrorFetch` (`registry.ts`) and turns any throw into
`500 {errors: [{code: "UNKNOWN", message: "internal error"}]}`. Errors use the OCI shape
`{errors: [{code, message}]}` with `Docker-Distribution-API-Version: registry/2.0`. No `/v1` base path here.

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Plain-text banner |
| GET, POST | `/token` | Issues a token (`tokenEndpoint`): the scanner credential → admin; a publisher's `ot_` token → push rights to the scopes `canPush` allows (a CI token only its own namespace and package); no credential → pull token; wrong credential → 401 `UNAUTHORIZED`. POST takes the OAuth2 password grant (other grants 400). Answers `{token, access_token, expires_in: 300, issued_at}` |
| any | `/v2/` or `/v2` | 200 `{}` if the request carries any valid credential or token (including an anonymous pull token), else the 401 Bearer challenge |
| GET, HEAD | `/v2/<name>/manifests/<tag|digest>` | Pull; hidden repos or hidden `name@digest` answer 404 `MANIFEST_UNKNOWN` to non-admins, and pending images (a publisher's push no published version uses) to everyone but admin and the repository's publishers |
| PUT | `/v2/<name>/manifests/<tag|digest>` | Push; ≤4 MB (`MAX_MANIFEST`, 413 `SIZE_INVALID`); digest must match; every referenced blob/manifest must already exist (400 `MANIFEST_BLOB_UNKNOWN` / `MANIFEST_UNKNOWN`); tag ref also writes `tags/<tag>`. A publisher's push also passes `publisherManifestProblem` (attached tags, 30 an hour, 2 GiB) and is marked pending and recorded |
| DELETE | `/v2/<name>/manifests/<digest>` | By digest only (400 `UNSUPPORTED` for tags); `deleteImage`; 202 |
| GET, HEAD | `/v2/<name>/blobs/<digest>` | Streams chunks; repo-level hidden check only for non-admins (404 `BLOB_UNKNOWN`) |
| DELETE | `/v2/<name>/blobs/<digest>` | 405 `UNSUPPORTED` (blobs go with their manifests) |
| POST | `/v2/<name>/blobs/uploads/` | Start upload. `?mount=<digest>` only short-circuits when this same repository already has the blob (201); `?digest=` does a monolithic upload; else 202 with `Location` |
| GET | `/v2/<name>/blobs/uploads/<id>` | Upload status, 204 with `Range` |
| PATCH | `/v2/<name>/blobs/uploads/<id>` | Append a chunk (checks `Content-Range` start = offset, else 416 `BLOB_UPLOAD_INVALID`); a body without `Content-Length` is stored in 16 MiB parts; the session stops at 2 GiB (413 `SIZE_INVALID`) |
| PUT | `/v2/<name>/blobs/uploads/<id>?digest=` | Final chunk and finish; content re-hashed, mismatch → 400 `DIGEST_INVALID` and chunks discarded |
| DELETE | `/v2/<name>/blobs/uploads/<id>` | Cancel; 204 |
| GET | `/v2/<name>/tags/list` | `?n`, `?last`; no hidden check |
| any | `/v2/<name>/referrers/<digest>` | 404 `UNSUPPORTED` (clients fall back to the `sha256-<hex>.sig` tag schema) |
| any | anything else | 404 `NAME_UNKNOWN` |

`<name>` must match the OCI name regex and be ≤255 chars; tags `^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`; digests
`sha256:<64 hex>` only.

### Auth rules and token flow

**`caller(req, env, repo)` decides `{admin, authed, push, publisher}`:**
- **Basic header.** The password part (any user name) is checked against `MIRROR_PUSH_TOKEN` in constant time, which
  makes the caller admin. Otherwise it may be a publisher's `ot_` token (`publisherFor`).
  - A publisher token is looked up in D1 with `lib/tokens.ts:findToken`, as `authenticate` does, and needs the
    `publish` scope.
  - It is only honoured when the Worker has `DB` and `MIRROR_PUSH_TOKEN`.
  - Its push rights to the request's repository come from `canPush`.
- **Bearer token.** Verified by HMAC-SHA256 of the base64url body `{adm, push, sub, tid, exp}`, keyed by
  `MIRROR_PUSH_TOKEN`, or by the fixed string `"anonymous-pull"` when the secret is unset; `exp` is now + 300 s.
  Without the secret, neither `adm` nor `push` counts, so a grant can't be forged.

**`canPush`.** The repository is `<namespace>/<name>` (two manifest slugs, not `private`). The user is an owner or
publisher of that namespace, which is not `rejected` or `suspended`, and there is no `hidden/<repo>` marker.

**`/token` (`tokenEndpoint`).**
- **Who gets what.**
  - With no credential, a pull token.
  - With the scanner credential, an admin token.
  - With a publisher token, push rights to each `scope=repository:<repo>:...push` that `canPush` allows. A wrong
    credential answers 401.
- **How to ask.** GET takes the credential as HTTP Basic. POST takes the OAuth2 password grant
  (`grant_type=password&username&password&scope`), which containerd, buildx and nerdctl try first. Other grants answer
  400 `UNSUPPORTED`, so those clients fall back to GET.

**Who may do what.**
- Writes need admin, except a publisher's pushes to a repository in its `push` set: blob uploads, and manifest PUTs.
  DELETE stays admin-only.
- Any request on `private` or `private/...` needs admin.
- A publisher without the right gets 403 `DENIED`; anyone else gets 401 with
  `WWW-Authenticate: Bearer realm="<origin>/token",service="<host>",scope="repository:<name>:pull,push"` (or `:pull`).

**Public reads.**
- Public `GET`/`HEAD` need no credential.
- A manifest with a `hidden/` marker answers 404 to everyone but admin.
- One with a `pending/<repo>@<digest>` marker answers 404 to everyone but admin and the repository's publishers.

**A publisher's manifest PUT.** It also must:
- for a tag `sha256-<hex>[.suffix]` (a signature, attestation or SBOM), name a digest some publisher pushed to this
  repository (`mirror_pushes`) or a hosted backup row, so a backup copy's signatures can't be replaced;
- stay within 30 version-tag pushes per namespace per hour (`TAG_PUSHES_PER_HOUR`, counted from `mirror_pushes`);
- keep the referenced blobs, index children included, within 2 GiB (`MAX_HOSTED_IMAGE_BYTES`, from the blob pointers'
  sizes).

The PUT writes a `pending/` marker (except for `sha256-*` tags) and a `mirror_pushes` row.

**Uploads.**
- An upload session holds at most 2 GiB (`MAX_UPLOAD_BYTES`; 413 `SIZE_INVALID`).
- A body without `Content-Length` is stored in parts of 16 MiB (`PART_SIZE`) instead of being buffered whole.
- A publisher's finished blobs count toward 10 GiB per namespace per day (`DAILY_PUSH_BYTES`; key
  `mirror_bytes|<namespace>` in `rate_limits`; 429 `TOOMANYREQUESTS`).

**Flows.**
- **The scanner.** `crane auth login mirror.otinstaller.com -u scanner -p "$MIRROR_PUSH_TOKEN"`, plus `docker login`
  for pulls of pending images. The client gets the 401 challenge, calls `/token` with the Basic credential, gets an
  admin token valid 300 s, and retries with `Bearer`.
- **A publisher.** `ot publish --image` does the same with Basic `ot:<ot_ token>` (`cli/internal/oci`).

**Functions shared with the API** (all in `registry.ts`, shared through the `MIRROR` bucket):
- `hideImage`: writes `hidden/<name>` or `hidden/<name>@<digest>` markers for takedowns.
- `deleteImage`: the takedown purge passes `minAgeMs` of a day, so blobs of a push in progress survive.
- `releaseImage`: clears `pending/` markers when a version is published.
- `imageExists` and `imagePlatforms`: the release checks.
- `sweepRepo` and `purgeUploads`: the nightly clean-up.

## 7. Errors

### Shape

`apiError(status, code, message, hint?)` (`lib/errors.ts`) throws an `HTTPException` whose body is:

```json
{ "error": { "code": "<code>", "message": "<message>", "hint": "<hint or omitted>", "docs": "https://otinstaller.com/docs/errors#<code>" } }
```

`ErrorStatus` allows 400, 401, 403, 404, 409, 410, 413, 429, 500, 503. Responses built by hand differ:

- 500 `internal_error`: `{error: {code, message, hint, docs, request_id}}` from `onError`.
- 404 `not_found`: `{error: {code, message, hint, docs}}` from `notFound`.
- 403 `insufficient_scope` from `enforceScopes`: adds `required_scope` and a `WWW-Authenticate` header.
- 429s from `rateLimited` add `retry_after_s` and the `Retry-After` and `RateLimit-Policy` headers.
- 401 `bad_signature` from the GitLab webhook: `{error: {code, message}}` (the GitHub webhook uses `apiError`).
- 400 `manifest_invalid` from `PUT /packages/:ns/:name/manifest`: `{error: {code, message, problems}}`.
- Import refusals with a draft's problems (`import_not_ready`): `{error: {code, message, problems}}` (no `docs`).
- `POST /admin/email-test` failures answer 502 with `{status, to, error}` (not an error envelope); 502 is outside
  `ErrorStatus`.
- Device-login HTML pages answer 400 or 410 with HTML, not JSON.

### Every code

"Documented" = an `### <code>` heading exists in `web/src/pages/docs/errors.md` (the `docs` link anchors on headings).
Every code below has one since the errors page was completed on 22 October 2026; `web/src/lib/errors-doc.test.ts` fails when a new code is added without an entry. Codes reached through `ImportProblem` (`refuse` in
imports.ts), `TransferError` (`fail` in transfers.ts) and `BackupError` (backups.ts) are turned into `apiError` by the
route wrappers, so they reach clients the same way.

| Code | Status | File(s) | Documented |
| --- | --- | --- | --- |
| account_already_linked | 409 | routes/auth.ts | yes |
| account_check_failed | 503 | direct.ts | yes |
| already_connected | 409 | routes/sources.ts | yes |
| already_published | 409 | imports.ts | yes |
| app_not_installed | 409 | routes/sources.ts, imports.ts | yes |
| asset_not_found | 404 | routes/guides.ts | yes |
| backup_not_found | 404 | routes/backups.ts | yes |
| bad_signature | 401 | routes/webhooks.ts (apiError for GitHub, hand-built for GitLab) | yes |
| bundle_invalid | 400 | direct.ts | yes |
| bundle_too_large | 413 | direct.ts | yes |
| cannot_ban_admin | 409 | routes/trust.ts | yes |
| community_namespace_missing | 409 | imports.ts | yes |
| destination_required | 400 | transfers.ts | yes |
| docs_not_found | 404 | routes/guides.ts | yes |
| feedback_not_found | 404 | routes/beta.ts | yes |
| forbidden | 403 | routes/review.ts, sources.ts, imports.ts, backups.ts; transfers.ts | yes |
| github_not_linked | 400 | routes/imports.ts, imports.ts | yes |
| github_permission_required | 403 | imports.ts | yes |
| gitlab_not_linked | 400 | routes/imports.ts, routes/sources.ts, imports.ts | yes |
| gitlab_scope_required | 403 | routes/sources.ts, imports.ts | yes |
| guide_not_found | 404 | routes/guides.ts | yes |
| import_finished | 409 | imports.ts | yes |
| import_not_detected | 409 | imports.ts | yes |
| import_not_found | 404 | imports.ts (`requireOwnImport`, via apiError) | yes |
| import_not_ready | 409 | imports.ts (with `problems`) | yes |
| internal_error | 500 | index.ts (`onError`, hand-built) | yes |
| invalid_backup_token | 401 | backups.ts | yes |
| invalid_body | 400 | index.ts, routes/auth.ts, device.ts, ops.ts, review.ts, transfers.ts, beta.ts, sources.ts, trust.ts, imports.ts, backups.ts | yes |
| invalid_category | 400 | routes/trust.ts | yes |
| invalid_drill_token | 401 | backups.ts | yes |
| invalid_email | 400 | routes/beta.ts | yes |
| invalid_kind | 400 | routes/beta.ts, imports.ts | yes |
| invalid_mode | 400 | routes/imports.ts, imports.ts | yes |
| invalid_parameter | 400 | index.ts, routes/auth.ts, beta.ts, guides.ts, trust.ts | yes |
| invalid_reason | 400 | routes/trust.ts | yes |
| invalid_replacement | 400 | routes/trust.ts | yes |
| invalid_repo | 400 | routes/imports.ts, routes/sources.ts | yes |
| insufficient_scope | 403 | scopes.ts (hand-built), routes/auth.ts | yes |
| invalid_scan_results | 400 | routes/review.ts | yes |
| invalid_scan_token | 401 | routes/review.ts | yes |
| invalid_scope | 400 | scopes.ts (`parseScopes`) | yes |
| invalid_signature | 403 | routes/backups.ts | yes |
| invalid_state | 409 | routes/trust.ts; transfers.ts | yes |
| length_required | 400 | routes/backups.ts | yes |
| license_not_redistributable | 400 | imports.ts | yes |
| manifest_in_repo | 409 (routes/imports.ts, imports.ts); 400 (one `refuse` in imports.ts) | routes/imports.ts, imports.ts | yes (same code with two statuses) |
| manifest_invalid | 400 | routes/imports.ts (hand-built, with `problems`); direct.ts (apiError with `problems`) | yes |
| manifest_name_taken | 409 | direct.ts (before an upload is read); also a problem code in `processJob` | yes |
| manifest_version_exists | 409 | direct.ts (before an upload is read); also a problem code in `processJob` | yes |
| manifest_name_mismatch | problem code inside `manifest_invalid` | routes/imports.ts | yes (and not in the CLI validator) |
| manifest_namespace_mismatch | 400 | imports.ts | yes |
| manifest_yaml_invalid | 400 | imports.ts | yes |
| mirror_already_imported | 409 | imports.ts | yes |
| name_taken | 409 | transfers.ts | yes |
| namespace_account_required | 403 | direct.ts | yes |
| namespace_in_review | 409 | routes/review.ts | yes |
| namespace_limit | 403 | direct.ts | yes |
| namespace_not_allowed | 409 (transfers.ts); 403 (direct.ts) | transfers.ts, direct.ts | yes (same code with two statuses) |
| namespace_not_found | 404 | index.ts, routes/review.ts, transfers.ts | yes |
| namespace_reserved | 400 | direct.ts | yes |
| namespace_taken | 409 | direct.ts | yes |
| namespace_unknown | 404 | direct.ts | yes |
| no_backup | 404 | backups.ts | yes |
| no_email | 409 | routes/beta.ts | yes |
| not_a_claim | 409 | transfers.ts | yes |
| not_a_transfer | 409 | transfers.ts | yes |
| not_accepted | 409 | transfers.ts | yes |
| not_admin | 403 | imports.ts | yes |
| not_community_admin | 403 | imports.ts | yes |
| not_community_packaged | 409 | transfers.ts | yes |
| not_configured | 503 | env.ts (`requireSecret`), routes/ops.ts | yes |
| not_found | 404 | index.ts (`notFound`, hand-built); transfers.ts | yes |
| not_maintainer | 403 | routes/sources.ts, imports.ts | yes |
| not_pending | 409 | routes/review.ts | yes |
| not_repo_owner | 403 | imports.ts | yes |
| not_verified | 409 | transfers.ts | yes |
| oauth_state_mismatch | 400 | routes/auth.ts | yes |
| page_not_found | 404 | routes/guides.ts | yes |
| page_not_rendered | 404 | routes/guides.ts | yes |
| payload_too_large | 413 | routes/webhooks.ts, routes/review.ts | yes |
| project_not_found | 404 | routes/sources.ts, imports.ts | yes |
| project_not_public | 400 | routes/sources.ts, imports.ts | yes |
| provider_already_linked | 409 | routes/auth.ts | yes |
| publish_in_progress | 409 | direct.ts | yes |
| publish_rate_limited | 429 | direct.ts | yes |
| readme_not_found | 404 | routes/guides.ts | yes |
| repo_not_found | 404 | imports.ts | yes |
| repo_not_public | 400 | imports.ts | yes |
| report_not_found | 404 | routes/trust.ts | yes |
| same_namespace | 409 | transfers.ts | yes |
| same_source | 409 | routes/sources.ts | yes |
| source_in_use | 409 | routes/sources.ts | yes |
| source_not_found | 404 | routes/sources.ts | yes |
| sync_rate_limited | 429 | routes/sources.ts | yes |
| token_not_found | 404 | routes/auth.ts | yes |
| too_large | 413 | routes/backups.ts | yes |
| too_many_reports | 429 | routes/trust.ts | yes |
| too_many_repos | 400 | routes/imports.ts | yes |
| too_many_requests | 429 | index.ts (30/min writes), routes/beta.ts (10/h feedback), direct.ts (5 namespace attempts a day) | yes, but the doc only describes the 30-a-minute write limit |
| tool_not_found | 404 | catalog.ts, index.ts, routes/guides.ts, sources.ts, trust.ts, transfers.ts, backups.ts; backups.ts (`BackupError`) | yes |
| tool_removed | 410 (catalog.ts, routes/trust.ts); 409 (routes/sources.ts, backups.ts) | catalog.ts, routes/trust.ts, routes/sources.ts, backups.ts | yes (same code with two statuses) |
| transfer_not_found | 404 | routes/transfers.ts | yes |
| unauthenticated | 401 | routes/auth.ts, review.ts, ops.ts, backups.ts | yes |
| unknown_provider | 404 (`/auth/:provider/*`); 400 (`/auth/device/start`, imports) | routes/auth.ts, routes/imports.ts | yes |
| upstream_has_manifest | 409 | imports.ts | yes |
| upstream_unknown | 409 | transfers.ts | yes |
| url_expired | 403 | routes/backups.ts | yes |
| user_not_found | 404 | routes/trust.ts | yes |
| version_not_found | 404 | index.ts, routes/guides.ts, review.ts, backups.ts | yes |
| wrapper_not_community | 409 | imports.ts | yes |
| wrapper_required | 400 | imports.ts | yes |

Count: 97 distinct codes in the table (including the problem code `manifest_name_mismatch`), all documented. Not covered here: the `manifest_*` / `content_*` / `artifact_*` / scan-verdict codes that the publish pipeline
records in `publish_jobs.problems_json` and commit statuses (they are not HTTP error responses), the import status code
`detection_failed`, and the mirror's OCI codes (section 6).

Ambiguities and caveats:

- Codes passed through `ImportProblem` / `TransferError` were found with a regex over literal `refuse(<status>, "<code>"`
  and `fail(<status>, "<code>"` calls; a call that builds its code dynamically would have been missed (none was found).
- The statuses for transfer and import codes come from those helpers, not from the route; they are the status the
  client sees.
