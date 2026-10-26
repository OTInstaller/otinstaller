# Registry database (Cloudflare D1)

Reference for the `otinstaller` D1 database used by the registry API (`api/`). Everything below is derived from
`api/migrations/*.sql` and the code in `api/src/`, `api/test/` and `api/scripts/`.

- Binding: `DB`, database name `otinstaller`, `migrations_dir: "migrations"` (`api/wrangler.jsonc`).
- 39 migrations, `0001` to `0039`.
- Final schema: **65 regular tables + 1 FTS5 virtual table (`tools_fts`)** = 66. FTS5 also creates its own shadow
  tables, which aren't listed here.

---

## 1. Migrations

| # | File | What it adds or changes |
| --- | --- | --- |
| 0001 | `0001_initial.sql` | Core schema: 25 tables (the plan's 24 plus `tool_secrets`), the `tools_fts` FTS5 table and its 3 sync triggers, and indexes `tools_status_installs`, `versions_tool_status`, `tool_io_lookup`, `sync_events_source`, `publish_jobs_status`, `reports_queue`. |
| 0002 | `0002_publish_intake.sql` | `installations` + `account_login`, `account_type`, `repository_selection`, `created_at`; `publish_jobs` + `installation_id`, `repo_id`, `commit_sha`, `tool_id`, `problems_json`, `attempts`, `updated_at`; indexes `publish_jobs_tool`, `sessions_user`, `api_tokens_user`. |
| 0003 | `0003_scans_review.sql` | `versions` + `scan_token_hash`, `scan_token_expires_at`, `scan_dispatched_at`, `expected_signer_regexp`, `expected_signer_issuer`, `rejected_reason`; partial unique index `versions_scan_token`; index `versions_status`; new table `notifications`. |
| 0004 | `0004_sync.sql` | **Rebuilds `sources`** (`sources_v2`, copy, drop, rename; `PRAGMA defer_foreign_keys = true`): `tool_id` becomes nullable, adds `namespace_id`, `path`, `connected_by`, `installation_id`, `description`, `topics`, `stars`, `archived`, `visibility`, `unavailable_since`, `created_at`, widens `sync_status`; indexes `sources_poll`, `sources_namespace`; `publish_jobs` + `source_id`; `versions` + `changelog`. |
| 0005 | `0005_imports.sql` | **Drops and recreates `imports`** (the 0001 placeholder was never written to), with `batch_id`, `community`, nullable `project_id`, `path`, `url`, `namespace`, `detection_json`, `wrapper_path`, `source_id`, `error_code`, `error`, `updated_at`, and CHECKs on provider, detected_kind, finish_mode and status; indexes `imports_user`, `imports_batch`. |
| 0006 | `0006_source_baseline_tags.sql` | `sources` + `baseline_tags` (release tags already there when a repo-mode source was connected, which sync never backfills). |
| 0007 | `0007_guides.sql` | `pages` + `toc_json`; `versions` + `search_text`; new table `page_links`; `tools` + `needs_update`, `dead_link_ratio`; index `tool_guides_tool`. |
| 0008 | `0008_page_link_scan_error.sql` | `page_links` + `scan_error` (why the URL Scanner did not scan a link). |
| 0009 | `0009_trust.sql` | `versions` + `removed_at`, `removed_by`, `removed_category`; `tools` + `removed_at`, `removed_reason`, `removed_category`, `deprecated_replacement`, `health_fail_streak`, `health_checked_at`; `reports` + `action`, `resolved_at`; `transfers` + `upstream_url`, `verification_error`, `accepted_by`, `completed_by`, `updated_at`; indexes `health_checks_tool`, `transfers_tool`, `transfers_status`, `audit_log_created`; new table `rate_limits`. |
| 0010 | `0010_osintverse_login.sql` | **Rebuilds `accounts`** (`accounts_new`, copy, drop, rename) so `provider` allows `'osintverse'`; new table `device_logins` and index `device_logins_expires`. |
| 0011 | `0011_backups.sql` | `tools` + `git_backups` (default 1), `legal_hold` (default 0), `legal_hold_reason`; new tables `backup_runs`, `backups`, `restore_drills`; indexes `backup_runs_status`, `backups_tool`, `backups_version`, `backups_delete`. |
| 0012 | `0012_feedback.sql` | New table `feedback` and index `feedback_queue`. (Its header says it was numbered after 0011, which was on its own branch at the time.) |
| 0013 | `0013_agent_tokens.sql` | `api_tokens` + `scoped` (INTEGER NN default 0; tokens minted before scopes were enforced keep 0 and every power); new table `install_clients`. Must be applied before an API that reads `scoped` is deployed: `authenticate` selects it on every token request. |
| 0014 | `0014_publisher_profiles.sql` | New tables `namespace_profiles` (host values, owner overrides, About, pins, sync state) and `namespace_hosts` (secondary GitHub or GitLab accounts shown on a profile); indexes `namespace_profiles_synced` and `audit_log_target` (for the profile's activity feed). |
| 0015 | `0015_release_notes.sql` | `versions` + `changelog_source` (`release` or `file`, CHECK); existing notes marked `release`. |
| 0016 | `0016_community.sql` | `users` + `handle` (unique, backfilled from `lower(login)`, a suffix on collision), `profile_hidden`, `posting_blocked_until`; new tables `community_roles`, `issues`, `issue_comments`, `confirmations`, `run_signals`, `content_flags`, `issue_subscriptions`; `health_checks` + `failure_class`; `tools` + `open_broken`, `open_outdated`. |
| 0017 | `0017_notifications.sql` | New tables `email_prefs` (per person: `community`, `owner_issues` as immediate/daily/off) and `inbox` (kind, scope community/owner_issues/account, summary, site path, read and emailed times); indexes `inbox_user`, `inbox_pending` (partial). |
| 0018 | `0018_requests.sql` | New tables `tool_requests` (one per repository: status, decline code, decision, the answering package, what otlite and the seed survey knew, votes, moderation) and `request_votes`; indexes `tool_requests_board`, `tool_requests_project`, `tool_requests_requester`, `request_votes_user`. |
| 0019 | `0019_people.sql` | New table `contributor_stats` (per person: issues opened and confirmed, replies, confirmations, requests made and published, issues triaged; recounted nightly); indexes `issues_author`, `issue_comments_author`, `confirmations_user`, `issues_closed_by`. |
| 0020 | `0020_community_wrappers.sql` | `tools` + `needs_first_review` (default 0), `submitted_by`, `upstream_url` (backfilled for community-packaged tools from the latest manifest's `homepage`); new tables `tool_maintainers` and `wrapper_submissions`; indexes `tool_maintainers_user`, `wrapper_submissions_status`, `wrapper_submissions_upstream`, `wrapper_submissions_repo`, `wrapper_submissions_user`. |
| 0021 | `0021_upstream_watch.sql` | New table `upstream_watch` (per community wrapper: the pin and how it was read, upstream's latest release, state, license, the releases ETag, a staff override, the last error) and index `upstream_watch_state`. |
| 0022 | `0022_bump_prs.sql` | New table `bump_prs` (one per community package and upstream release: the pull request's number, URL and branch, `open`/`merged`/`closed`, the version the merge released, who merged it) and index `bump_prs_open`. |
| 0023 | `0023_direct_publish.sql` | Direct publishing (`ot publish`): `publish_jobs` + `namespace_id` (FK namespaces), `bundle_key` (R2 `CONTENT` prefix of the upload), `submitted_by` (FK users), index `publish_jobs_namespace`; `namespaces` + `created_by` (FK users: who made a registry namespace). Apply before an API that selects these columns is deployed. |
| 0024 | `0024_hosted_images.sql` | Images hosted on the mirror (`ot publish --image`): new table `mirror_pushes` (every manifest a publisher pushes: repo, digest, tag, user, token, size; indexes `mirror_pushes_repo`, `mirror_pushes_created`), for the push limits and the nightly sweep; `backups` + `hosted` (INTEGER NN default 0: the image row is the image itself, never an install fallback). The mirror Worker binds the same database from then on. |
| 0025 | `0025_trusted_publishers.sql` | Trusted publishing (`ot publish --oidc`): new table `trusted_publishers` (indexes `trusted_publishers_repo`, `trusted_publishers_namespace`); `api_tokens` + `namespace_id` (FK namespaces, cascade), `package`, `trusted_publisher_id` (FK, set null), `oidc_json`, `jti` (unique index `api_tokens_jti`) for the restricted CI tokens; `publish_jobs` + `trusted_publisher_id` (FK, set null), `ci_json`. Apply before an API that selects these columns is deployed: `findToken` reads them on every token request, in the API and the mirror. |
| 0026 | `0026_request_threads.sql` | New tables `request_comments` (replies on tool requests, moderated like issue comments) and `request_subscriptions` (backfilled with each request's requester); `tool_requests` + `comment_count`, `locked_at`; `content_flags` rebuilt so `target_kind` also takes `request` and `request_comment`; indexes `request_comments_request`, `request_comments_held` (partial), `request_comments_author`, and `content_flags_open` again. |
| 0027 | `0027_change_proposals.sql` | New table `change_proposals` (a maintainer's change to a community package beyond its pin: the pull request, the proposer's title and note, the files it writes, the version, whether it builds, the reviewer's checks, status, decision and released version); indexes `change_proposals_status`, `change_proposals_tool`, `change_proposals_proposer`. |
| 0028 | `0028_bump_outcomes.sql` | `bump_prs` rebuilt: `status` also takes `released` and `failed`; new columns `auto`, `merge_sha`, `merged_at`, `run_url`, `attempts`, `error_code`, `error`, `released_at` (merged rows whose version is published become `released`); index `bump_prs_inflight (status, merged_at)`; `tools` + `auto_release` (INTEGER NN default 1: whether `UPSTREAM_WATCH=auto` may release the package's bumps). |
| 0029 | `0029_package_follows.sql` | New table `package_follows` (who follows which package's releases) and index `package_follows_user`; `email_prefs` + `releases` (CHECK immediate/daily/off, default immediate); `versions` + `announced_at` (backfilled to `published_at`); `inbox` rebuilt so `scope` also takes `releases`, indexes `inbox_user` and `inbox_pending` again. Apply before an API that writes release items is deployed. |
| 0030 | `0030_follows.sql` | New table `follows` (who follows which publisher or input type: `kind` CHECK publisher/input, `target`) and index `follows_target`. Apply before an API that reads it is deployed. |
| 0031 | `0031_dependency_and_base_watch.sql` | New tables `dependency_watch` (a first-party tool's requirements.txt pins against PyPI), `base_images` (each Docker Hub base tag's current digest) and `base_watch` (each build's base image, the digest when its version was first seen, rebuilds); `bump_prs` + `kind` (CHECK upstream/dependency/rebuild, default upstream). Apply before an API that has the build watcher is deployed. |
| 0032 | `0032_problem_signals.sql` | New table `problem_signals` (anonymous daily counts from a tool page's **Report a problem**: broken or outdated, by version and platform), with `CREATE TABLE IF NOT EXISTS`: production got the table on 24 Oct from this file under its first name, `0030_problem_signals.sql`, so there it is recorded as applied and does nothing. Apply before an API that serves `POST /tools/:ns/:name/problem-reports` is deployed. |
| 0033 | `0033_email_retries.sql` | `notifications` + `body`, `headers_json`, `attempts` (NN default 0), `sent_at`; partial index `notifications_retry`. Apply before an API that writes them is deployed. |
| 0034 | `0034_namespace_rename_search.sql` | Trigger `tools_fts_namespace_rename` (AFTER UPDATE OF name ON namespaces): rewrites the namespace's tools' `tools_fts` rows with the new name. |
| 0035 | `0035_cache_epoch.sql` | New table `settings` (`key` PK, `value`, `updated_at`) with the row `cache_epoch`, which edge-cache keys carry and removals and yanks move on. Apply before an API that reads it is deployed. |
| 0036 | `0036_people_and_notification_settings.sql` | `users` + `display_name`, `bio`, `location`, `website` (TEXT), `links_json` (TEXT NN default `'[]'`), `handle_changed_at`; new table `handle_aliases` (old handles, kept by their owner and redirecting) and index `handle_aliases_user`; `package_follows` + `level` (CHECK all/releases/muted, default all); `email_prefs` + `lifecycle` and `security` (CHECK immediate/daily/off, default immediate, then set to each row's `releases`), `inbox_muted_json` (TEXT NN default `'[]'`), `email_provider`; `inbox` rebuilt so `scope` also takes `lifecycle` and `security`, indexes `inbox_user` and `inbox_pending` again. Apply before an API that reads them is deployed. |
| 0037 | `0037_indexnow.sql` | New table `indexnow_queue` (`path` PK, `queued_at`) and index `idx_indexnow_queue_queued`: site pages waiting to be sent to IndexNow. Apply before an API that writes it is deployed. |
| 0038 | `0038_versions_artifact_from_manifest.sql` | Data only: sets `versions.runtime_kind` and `artifact_ref` from `manifest_json` where they differ (versions re-released after a rejection kept the rejected release's; naminter 1.0.9 and octosuite 5.1.0 in production). |
| 0039 | `0039_community_health.sql` | Drops table `health_checks` and column `tools.health_fail_streak` (the nightly health check is gone); recomputes `tools.health_status` and `health_checked_at` for every tool from issues and confirmations, which also clears `not_checked`. |

---

## 2. Final schema, by area

Notation: `TEXT`/`INTEGER`/`REAL` are the declared SQLite types. "ms" means a Unix-millisecond timestamp. NN means
NOT NULL. Defaults are listed where they exist.

### 2.1 Identity and auth

#### `users`
Purpose: one person on the registry. Rows are created at first sign-in (`routes/auth.ts`).
- PK `id` TEXT (ULID)
- `login` TEXT NN · `name`, `email`, `avatar_url` TEXT (`name` is the sign-in provider's and never shown)
- `is_admin` INTEGER NN default 0 · `is_reviewer` INTEGER NN default 0 (staff flags, 0/1)
- `banned_at` INTEGER (ms; set by the ban route in `routes/trust.ts`)
- `created_at` INTEGER NN (ms)
- 0016: `handle` TEXT (unique index `users_handle`), `profile_hidden` INTEGER NN default 0, `posting_blocked_until`
- 0036, what the person writes on their profile (`PUT /me/profile`): `display_name`, `bio`, `location`, `website`
  TEXT, `links_json` TEXT NN default `'[]'` (up to 3 `{provider, url}`); `handle_changed_at` INTEGER (the last
  `PUT /me/handle`; the next change waits 30 days)
- No CHECKs.

#### `handle_aliases` (0036)
Purpose: handles people had before. Each stays its owner's: `/people/<old>` answers their profile with `moved_to`, nobody
else can take it, and new users whose login matches one get a suffix, as for a taken handle.
- PK `handle` TEXT · `user_id` TEXT NN → `users(id)` ON DELETE CASCADE · `created_at` INTEGER NN
- Index `handle_aliases_user (user_id)`. Written by `people.ts:changeHandle` (a row for the old handle; taking an old
  handle back deletes its row).

#### `accounts` (rebuilt in 0010)
Purpose: a linked sign-in provider identity, with its encrypted provider tokens.
- PK `id` TEXT
- `user_id` TEXT NN → `users(id)` ON DELETE CASCADE
- `provider` TEXT NN CHECK `('github', 'gitlab', 'osintverse')`
- `provider_user_id` TEXT NN · `login` TEXT NN · `email` TEXT
- `access_token_enc`, `refresh_token_enc` TEXT (AES-GCM with `TOKEN_ENC_KEY`) · `scopes` TEXT · `expires_at` INTEGER
- `created_at` INTEGER NN
- UNIQUE `(provider, provider_user_id)`, UNIQUE `(user_id, provider)`

#### `sessions`
Purpose: web sessions (the `ot_session` cookie). Only the hash is stored.
- PK `id` TEXT · `user_id` TEXT NN → `users(id)` ON DELETE CASCADE
- `token_hash` TEXT NN UNIQUE · `expires_at` INTEGER NN · `user_agent` TEXT
- Index `sessions_user (user_id)` (0002)

#### `api_tokens`
Purpose: `ot_...` bearer tokens for the CLI.
- PK `id` TEXT · `user_id` TEXT NN → `users(id)` ON DELETE CASCADE
- `name` TEXT NN · `token_hash` TEXT NN UNIQUE
- `scopes` TEXT NN default `'read'` (a comma list from `read`, `publish`, `manage`, `feedback`, `staff`; `mintApiToken`
  in `routes/auth.ts` writes the requested scopes, by default the four user scopes)
- `scoped` INTEGER NN default 0 (0013): 1 for every token minted since; `enforceScopes` (`scopes.ts`) only limits
  tokens with `scoped = 1`
- `last_used_at`, `expires_at`, `revoked_at` INTEGER · `created_at` INTEGER NN. `expires_at` is set for `/me/tokens`
  tokens (90 days unless `expires_in_days` says otherwise) and left null for `ot login` tokens unless asked
- Index `api_tokens_user (user_id)` (0002)
- CI tokens (0025, trusted publishing): `namespace_id` TEXT → `namespaces(id)` ON DELETE CASCADE (set means the token
  is restricted to that namespace) · `package` TEXT (and that package) · `trusted_publisher_id` TEXT →
  `trusted_publishers(id)` ON DELETE SET NULL · `oidc_json` TEXT (the run: provider, repository and its id, ref, sha,
  workflow, run, environment, event, actor) · `jti` TEXT (`<provider>:<the ID token's jti>`; unique index
  `api_tokens_jti`, so an ID token is exchanged once). Minted with scopes `read,publish`, `scoped = 1` and a one-hour
  `expires_at`; deleted two days after expiry (`purgeCiTokens`); not listed by `/me/tokens`
- Audit: `token.create`, `token.revoke` and `token.write` (every successful write made with a token) rows in
  `audit_log`; `token.create_ci` for a CI token, with `actor_kind` `github` or `gitlab`

#### `device_logins` (0010)
Purpose: the registry's own device flow for `ot login --osintverse`.
- PK `id` TEXT
- `provider` TEXT NN (always `'osintverse'` in `routes/device.ts`)
- `device_code_hash` TEXT NN UNIQUE · `user_code` TEXT NN UNIQUE
- `status` TEXT NN default `'pending'` CHECK `('pending', 'authorized', 'approved', 'denied', 'consumed')`
- `user_id` TEXT → `users(id)` ON DELETE CASCADE
- `confirm_token_hash`, `client_info` TEXT · `last_polled_at` INTEGER
- `created_at` INTEGER NN · `expires_at` INTEGER NN
- Index `device_logins_expires (expires_at)`

### 2.2 Namespaces

#### `namespaces`
Purpose: a publisher (GitHub user or org, GitLab group, or a registry-owned namespace).
- PK `id` TEXT
- `provider` TEXT NN CHECK `('github', 'gitlab', 'registry')`
- `provider_owner_id` TEXT NN · `name` TEXT NN UNIQUE
- `kind` TEXT NN CHECK `('user', 'org', 'group')`
- `display_name`, `avatar_url` TEXT
- `status` TEXT NN default `'pending_review'` CHECK `('pending_review', 'active', 'rejected', 'suspended')`
- `verified` INTEGER NN default 0
- `reviewed_by` TEXT → `users(id)` · `reviewed_at` INTEGER · `review_notes` TEXT
- `created_at` INTEGER NN
- `created_by` TEXT → `users(id)` (0023): the user who made a registry namespace with `POST /namespaces`; NULL for
  GitHub and GitLab namespaces and the seed. Such a namespace has `provider = 'registry'` and
  `provider_owner_id = id`.
- UNIQUE `(provider, provider_owner_id)`

#### `namespace_members`
Purpose: who may act for a namespace.
- PK `(namespace_id, user_id)` (composite)
- `namespace_id` TEXT NN → `namespaces(id)` ON DELETE CASCADE · `user_id` TEXT NN → `users(id)` ON DELETE CASCADE
- `role` TEXT NN CHECK `('owner', 'publisher')`

#### `namespace_profiles` (0014)
Purpose: what a publisher's profile shows, synced from GitHub or GitLab, plus the owner's edits. One row per namespace,
created by the first sync or edit.
- PK `namespace_id` TEXT → `namespaces(id)` ON DELETE CASCADE
- From the host (rewritten by every successful sync): `host_login`, `host_url`, `host_name`, `host_bio`, `host_location`,
  `host_website`, `host_company`, `host_avatar_url` TEXT; `host_socials_json` TEXT NN default `'[]'` (`[{provider, url}]`);
  `host_members_json` TEXT NN default `'[]'` (public org or group members, `[{login, avatar_url, url}]`, at most 24);
  `host_created_at` INTEGER. Never an email address.
- `custom_json` TEXT NN default `'{}'`: overrides by field (`display_name`, `bio`, `location`, `website`, `company`,
  `avatar_url`, `socials`); a field that is absent uses the host value, `""` shows nothing
- `about_md`, `about_html` TEXT (the About section and its sanitized rendering) · `pins_json` TEXT NN default `'[]'` (at
  most 6 package names) · `hide_details` INTEGER NN default 0
- `sync_status` TEXT NN default `'never'` CHECK `('never', 'ok', 'error')` · `sync_error` TEXT · `synced_at` INTEGER ·
  `updated_at` INTEGER NN

#### `namespace_hosts` (0014)
Purpose: GitHub or GitLab accounts an owner linked to a profile besides the namespace's own; the namespace keeps its one
`(provider, provider_owner_id)` key.
- PK `(namespace_id, provider)` · `namespace_id` TEXT NN → `namespaces(id)` ON DELETE CASCADE
- `provider` TEXT NN CHECK `('github', 'gitlab')` · `provider_owner_id`, `login` TEXT NN · `kind` TEXT NN CHECK
  `('user', 'org', 'group')` · `linked_by` TEXT → `users(id)` ON DELETE SET NULL · `created_at` INTEGER NN

#### `trusted_publishers` (0025)
Purpose: a GitHub Actions workflow or GitLab CI pipeline a namespace's owner trusts to publish into it with
`ot publish --oidc` (`trusted.ts`).
- PK `id` TEXT · `namespace_id` TEXT NN → `namespaces(id)` ON DELETE CASCADE
- `provider` TEXT NN CHECK `('github', 'gitlab')` · `repository` TEXT NN (owner/name or group/project, lowercase)
- `repository_id`, `owner_id` TEXT: NULL until the first run, which pins them (a repository deleted and created again
  under the name, or moved to another owner, no longer matches)
- `workflow`, `environment`, `package` TEXT: NULL means any; `environment` is compared without case, and a NULL one
  refuses `pull_request_target` and `merge_request_event` runs
- `created_by` TEXT NN → `users(id)` ON DELETE CASCADE (the CI token acts for this owner, who must still be a member) ·
  `created_at` INTEGER NN · `last_used_at` INTEGER
- Indexes `trusted_publishers_repo (provider, repository, namespace_id)`, `trusted_publishers_namespace (namespace_id)`
- Audit: `trusted_publisher.add`, `trusted_publisher.remove` (removing one revokes the tokens it minted)

#### `installations`
Purpose: a GitHub App installation and which repositories it covers.
- PK `id` TEXT
- `github_installation_id` INTEGER NN UNIQUE
- `namespace_id` TEXT → `namespaces(id)`
- `repo_ids` TEXT NN default `'[]'` (a JSON array of repository IDs; no `_json` suffix)
- `suspended_at` INTEGER
- `account_login`, `account_type` TEXT (0002)
- `repository_selection` TEXT NN default `'selected'` (0002; the code compares it with `'all'`)
- `created_at` INTEGER (0002, nullable)

### 2.3 Packages and versions

#### `tools`
Purpose: a package (`kind` tool or guide) at `<namespace>/<name>`.
- PK `id` TEXT
- `namespace_id` TEXT NN → `namespaces(id)`
- `kind` TEXT NN default `'tool'` CHECK `('tool', 'guide')`
- `name` TEXT NN · `summary` TEXT NN
- `categories` TEXT NN default `'[]'` · `tags` TEXT NN default `'[]'` (JSON arrays, no `_json` suffix)
- `repo_url` TEXT
- `latest_version_id` TEXT (**no FK**; set by `publishVersion` / `recomputeLatest`)
- `status` TEXT NN default `'active'` CHECK `('active', 'deprecated', 'removed')`
- `deprecated_message` TEXT · `deprecated_replacement` TEXT (0009)
- `community_packaged` INTEGER NN default 0
- `stars_count` INTEGER NN default 0 · `installs_30d` INTEGER NN default 0
- `health_status` TEXT NN default `'unknown'` CHECK `('unknown', 'healthy', 'broken', 'not_checked')`; from community
  reports since 0039 (see 3.9), and `not_checked` is no longer set
- `health_checked_at` INTEGER (0009): since 0039, the latest "works for me" on the latest version in the last 30 days;
  null when there is none
- `readme_text` TEXT NN default `''` (feeds `tools_fts.body`)
- `needs_update` INTEGER NN default 0 · `dead_link_ratio` REAL (0007, guides)
- `removed_at` INTEGER · `removed_reason` TEXT · `removed_category` TEXT (0009)
- `git_backups` INTEGER NN default 1 · `legal_hold` INTEGER NN default 0 · `legal_hold_reason` TEXT (0011)
- `created_at`, `updated_at` INTEGER NN
- UNIQUE `(namespace_id, name)`; index `tools_status_installs (status, installs_30d DESC)`
- Triggers `tools_fts_insert`, `tools_fts_update` (on `name, summary, tags, readme_text, namespace_id`) and
  `tools_fts_delete` keep `tools_fts` in sync, keyed by `tools.rowid`.

#### `versions`
Purpose: one release of a tool or guide, holding its full manifest.
- PK `id` TEXT · `tool_id` TEXT NN → `tools(id)`
- `version` TEXT NN · `semver_major`, `semver_minor`, `semver_patch` INTEGER NN · `semver_pre` TEXT NN default `''`
- `manifest_json` TEXT NN · `runtime_kind` TEXT · `artifact_ref` TEXT (the image ref or `sha256:<wheel hash>`) · `git_sha` TEXT
- `signer_identity`, `signer_issuer` TEXT (set from a passing signature scan)
- `scan_status` TEXT NN default `'pending'` CHECK `('pending', 'pass', 'warn', 'fail')`
- `status` TEXT NN default `'received'` CHECK `('received', 'validating', 'scanning', 'awaiting_review', 'published', 'rejected', 'yanked', 'removed')`
- `removed_reason` TEXT · `removed_at` INTEGER · `removed_by` TEXT → `users(id)` · `removed_category` TEXT (last three from 0009)
- `yanked_at`, `published_at` INTEGER · `created_at` INTEGER NN
- `scan_token_hash` TEXT · `scan_token_expires_at` INTEGER · `scan_dispatched_at` INTEGER (0003)
- `expected_signer_regexp`, `expected_signer_issuer` TEXT (0003) · `rejected_reason` TEXT (0003)
- `changelog` TEXT (0004; release notes as cleaned Markdown, rendered when served) · `changelog_source` TEXT (0015; `release` | `file`) · `search_text` TEXT (0007; plain text copied to `tools.readme_text` when it becomes latest)
- UNIQUE `(tool_id, version)`
- Indexes `versions_tool_status (tool_id, status, published_at DESC)`, `versions_status (status, scan_dispatched_at)`,
  partial UNIQUE `versions_scan_token (scan_token_hash) WHERE scan_token_hash IS NOT NULL`

#### `tool_io`
Purpose: the input and output types of a tool's latest version, for search filters.
- PK `(tool_id, direction, type)` · `tool_id` → `tools(id)` ON DELETE CASCADE
- `direction` TEXT NN CHECK `('in', 'out')` · `type` TEXT NN (no CHECK; only entity types, never string/integer/boolean/enum)
- Index `tool_io_lookup (direction, type, tool_id)`

#### `tool_secrets`
Purpose: API keys a tool declares (drives the "no API keys needed" filter).
- PK `(tool_id, name)` · `tool_id` → `tools(id)` ON DELETE CASCADE · `required` INTEGER NN (0/1)

#### `tool_guides`
Purpose: links a guide to its `related_tools`.
- PK `(guide_id, tool_id)`; both → `tools(id)` ON DELETE CASCADE
- Index `tool_guides_tool (tool_id)` (0007)

#### `stars`
Purpose: a user's star on a package.
- PK `(user_id, tool_id)`; `user_id` → `users(id)`, `tool_id` → `tools(id)`, both ON DELETE CASCADE · `created_at` INTEGER NN

#### `install_counts`
Purpose: daily install counts per version (from `POST /installs`).
- PK `(tool_id, version_id, day)` · `tool_id` → `tools(id)` ON DELETE CASCADE · `version_id` → `versions(id)`
- `day` TEXT NN (`YYYY-MM-DD`, UTC) · `count` INTEGER NN default 0

#### `install_clients` (0013)
Purpose: daily install counts by kind of client, with no IP, user, token or package.
- PK `(day, client)` · `day` TEXT NN (`YYYY-MM-DD`, UTC) · `client` TEXT NN CHECK in (`cli`, `mcp`, `ci`, `other`) ·
  `count` INTEGER NN default 0
- Written by `POST /installs` from the body's `client` (anything unknown counts as `other`), in the same batch as
  `install_counts`.

#### `aliases`
Purpose: old addresses of transferred or renamed packages.
- PK `(old_namespace, old_name)` (TEXT names, not IDs) · `tool_id` TEXT NN → `tools(id)` · `created_at` INTEGER NN

### 2.4 Publishing and sync

#### `sources` (rebuilt in 0004)
Purpose: a package's source repository, and the state of keeping it in sync. It can exist before the package does.
- PK `id` TEXT
- `tool_id` TEXT UNIQUE → `tools(id)` (nullable since 0004)
- `namespace_id` TEXT → `namespaces(id)`
- `provider` TEXT NN CHECK `('github', 'gitlab')` · `project_id` TEXT NN · `path` TEXT · `url` TEXT NN · `default_branch` TEXT
- `manifest_mode` TEXT NN default `'repo'` CHECK `('repo', 'registry')` · `registry_manifest_json` TEXT
- `connected_by` TEXT → `users(id)` · `installation_id` INTEGER (the GitHub installation ID, not an FK)
- `webhook_id`, `webhook_secret_hash` TEXT
- Repository metadata: `description` TEXT, `topics` TEXT (JSON array), `stars` INTEGER, `archived` INTEGER NN default 0, `visibility` TEXT
- `etag` TEXT · `last_event_at`, `last_poll_at` INTEGER
- `sync_status` TEXT NN default `'ok'` CHECK `('ok', 'paused', 'error', 'unavailable', 'transfer_pending')`
- `last_error` TEXT · `unavailable_since` INTEGER · `created_at` INTEGER (nullable)
- `baseline_tags` TEXT (0006, JSON array of tags)
- UNIQUE `(provider, project_id)`; indexes `sources_poll (sync_status, last_poll_at)`, `sources_namespace (namespace_id)`

#### `sync_events`
Purpose: a log of webhook deliveries and polls per source, deduplicated by provider event ID.
- PK `id` TEXT · `source_id` TEXT NN → `sources(id)` ON DELETE CASCADE
- `provider_event_id` TEXT NN UNIQUE
- `kind` TEXT NN CHECK `('tag', 'release', 'push', 'repo', 'poll', 'manual')`
- `payload_summary` TEXT · `status` TEXT NN (no CHECK; `recordEvent` writes `'ok'` by default, `'error'` on poll failure) · `error` TEXT
- `received_at` INTEGER NN
- Index `sync_events_source (source_id, received_at DESC)`

#### `publish_jobs`
Purpose: one attempt to publish a release: a tag (from a webhook, a poll or an import) or an upload (`ot publish`).
- PK `id` TEXT · `delivery_id` TEXT NN UNIQUE (dedup key; `direct:<id>` for an upload)
- `provider` TEXT NN (`github`, `gitlab`, or `direct` for an upload with no repository) · `repo` TEXT NN
  (`<ns>/<name>` for an upload) · `tag` TEXT NN (`v<version>` for an upload)
- Bundle jobs (0023): `namespace_id` TEXT → `namespaces(id)` (tag jobs find theirs through the installation or the
  source) · `bundle_key` TEXT (`uploads/<id>` in R2 `CONTENT`; kept after the files are deleted, so it also marks the
  job as an upload) · `submitted_by` TEXT → `users(id)`. Index `publish_jobs_namespace (namespace_id, created_at)`
- CI uploads (0025): `provider`, `repo` and `repo_id` are the repository the run's ID token proved, `delivery_id` is
  `ci:<id>`, `tag` and `commit_sha` come from a tag ref (else `v<version>` and NULL) · `trusted_publisher_id` TEXT →
  `trusted_publishers(id)` ON DELETE SET NULL · `ci_json` TEXT (`{workflow, ref, sha, run}`, shown on the job page)
- `version_id` TEXT → `versions(id)` · `tool_id` TEXT → `tools(id)` (0002) · `source_id` TEXT → `sources(id)` (0004)
- `status` TEXT NN (**no CHECK**; values in section 3)
- `error_code`, `error_detail` TEXT · `problems_json` TEXT (0002)
- `installation_id` INTEGER · `repo_id` TEXT · `commit_sha` TEXT · `attempts` INTEGER NN default 0 · `updated_at` INTEGER (all 0002)
- `created_at` INTEGER NN
- Indexes `publish_jobs_status (status, created_at)`, `publish_jobs_tool (tool_id, created_at DESC)`

### 2.5 Imports

#### `imports` (recreated in 0005)
Purpose: an import-wizard draft for one repository (single or bulk).
- PK `id` TEXT · `user_id` TEXT NN → `users(id)`
- `batch_id` TEXT (bulk imports) · `community` INTEGER NN default 0
- `provider` TEXT NN CHECK `('github', 'gitlab')` · `project_id` TEXT (nullable until detected) · `path` TEXT NN · `url` TEXT · `namespace` TEXT (a name, not an ID)
- `detected_kind` TEXT CHECK `('docker', 'pipx', 'guide')` · `detection_json` TEXT · `draft_manifest_json` TEXT
- `finish_mode` TEXT CHECK `('pr', 'registry', 'connect', 'wrapper')` · `wrapper_path` TEXT · `pr_url` TEXT
- `source_id` TEXT → `sources(id)`
- `status` TEXT NN default `'detecting'` CHECK `('detecting', 'draft', 'ready', 'finished', 'failed')`
- `error_code`, `error` TEXT · `created_at`, `updated_at` INTEGER NN
- Indexes `imports_user (user_id, created_at DESC)`, `imports_batch (batch_id)`

### 2.6 Scans and review

#### `scans`
Purpose: one check result for a version (scanner callback for tools, Worker content checks for guides).
- PK `id` TEXT · `version_id` TEXT NN → `versions(id)` ON DELETE CASCADE
- `kind` TEXT NN CHECK `('signature', 'vuln', 'malware', 'smoke', 'sbom', 'links', 'pii')`
- `result` TEXT NN CHECK `('pass', 'warn', 'fail')`
- `summary_json` TEXT · `report_r2_key` TEXT · `ran_at` INTEGER NN

Review has no table of its own: it uses `namespaces.status/reviewed_*`, `versions.status = 'awaiting_review'` and `audit_log`.

### 2.7 Guides and pages

#### `pages`
Purpose: navigation for a version's rendered guide or docs pages. The HTML is stored in R2 `CONTENT`.
- PK `id` TEXT · `version_id` TEXT NN → `versions(id)` ON DELETE CASCADE
- `path` TEXT NN · `title` TEXT NN · `position` INTEGER NN · `r2_key` TEXT
- `word_count` INTEGER NN default 0 · `dead_links` INTEGER NN default 0 · `toc_json` TEXT (0007)
- UNIQUE `(version_id, path)`

#### `page_links` (0007)
Purpose: every link found in a version's pages, for link checks at publish time and nightly.
- PK `id` TEXT · `version_id` TEXT NN → `versions(id)` ON DELETE CASCADE
- `page_path` TEXT NN · `url` TEXT NN · `line` INTEGER
- `status` TEXT NN default `'pending'` CHECK `('pending', 'ok', 'dead', 'missing', 'skipped', 'unchecked', 'malicious')`
- `http_status` INTEGER · `scan_id` TEXT · `scan_verdict` TEXT (clean / malicious / unknown; no CHECK) · `scan_error` TEXT (0008) · `checked_at` INTEGER
- Index `page_links_version (version_id, url)`

### 2.8 Trust and takedowns

#### `reports`
Purpose: abuse or quality reports on a package or version.
- PK `id` TEXT · `tool_id` TEXT NN → `tools(id)` · `version_id` TEXT → `versions(id)` · `reporter_id` TEXT → `users(id)` (null for anonymous reports)
- `reason` TEXT NN CHECK `('malware', 'policy', 'impersonation', 'license', 'broken', 'other')`
- `details` TEXT
- `status` TEXT NN default `'open'` CHECK `('open', 'actioned', 'dismissed')`
- `resolved_by` TEXT → `users(id)` · `resolution_note` TEXT · `action` TEXT (0009) · `resolved_at` INTEGER (0009)
- `created_at` INTEGER NN
- Index `reports_queue (status, created_at)`

Takedowns have no table of their own. They are columns: `versions.removed_*`, `tools.removed_*`, `tools.legal_hold*`,
`backups.delete_after`.

### 2.9 Transfers and claims

#### `transfers`
Purpose: an owner's transfer offer (`kind = 'transfer'`) or a claim of a community wrapper by the upstream maintainer (`kind = 'claim'`).
- PK `id` TEXT · `tool_id` TEXT NN → `tools(id)`
- `from_namespace_id` TEXT NN → `namespaces(id)` · `to_namespace_id` TEXT → `namespaces(id)`
- `requested_by` TEXT NN → `users(id)`
- `kind` TEXT NN CHECK `('claim', 'transfer')`
- `verification` TEXT CHECK `('linked_account', 'claim_file')` · `claim_token_hash` TEXT
- `source_choice` TEXT CHECK `('upstream', 'wrapper')` (claims insert `'upstream'`, transfers insert `'wrapper'`)
- `status` TEXT NN default `'pending'` CHECK `('pending', 'verified', 'accepted', 'completed', 'declined')`
- `created_at` INTEGER NN · `completed_at` INTEGER
- `upstream_url`, `verification_error` TEXT · `accepted_by`, `completed_by` TEXT → `users(id)` · `updated_at` INTEGER (all 0009)
- Indexes `transfers_tool (tool_id, status)`, `transfers_status (status, created_at)`

### 2.10 Backups and drills (0011)

#### `backup_runs`
Purpose: one backup job sent to registry-ops. Its token authorizes a single completion call.
- PK `id` TEXT · `tool_id` TEXT NN → `tools(id)` · `version_id` TEXT → `versions(id)` (null for weekly runs)
- `trigger` TEXT NN CHECK `('release', 'weekly', 'manual')`
- `token_hash` TEXT · `expires_at` INTEGER (release runs: 3 h, `RELEASE_TTL`)
- `status` TEXT NN default `'pending'` CHECK `('pending', 'dispatched', 'completed', 'expired', 'failed')`
- `error` TEXT · `created_at` INTEGER NN · `completed_at` INTEGER
- Index `backup_runs_status (status, expires_at)`

#### `backups`
Purpose: one backed-up item. `location` is the R2 key (git, wheel) or the mirror's `repository@digest` (image).
- PK `id` TEXT · `run_id` TEXT → `backup_runs(id)` · `tool_id` TEXT NN → `tools(id)` · `version_id` TEXT → `versions(id)`
- `kind` TEXT NN CHECK `('git', 'wheel', 'image')` · `location` TEXT NN
- `visibility` TEXT NN default `'private'` CHECK `('public', 'private')` (git is always private)
- `weekly` INTEGER NN default 0
- `status` TEXT NN default `'pending'` CHECK `('pending', 'stored', 'too_large', 'failed', 'deleted')`
- `size_bytes` INTEGER · `sha256` TEXT · `filename` TEXT · `refs_count` INTEGER · `detail` TEXT
- `delete_after` INTEGER (ms; set by a takedown (+14 days, `TAKEDOWN_GRACE`) or a git-backup opt-out (now); cleared by a legal hold)
- `created_at` INTEGER NN · `stored_at`, `deleted_at` INTEGER
- `hosted` INTEGER NN default 0 (0024): 1 for an image a publisher pushed to the mirror itself (`recordHostedImage`, at
  publishing, with no run). Takedowns, purges, legal holds and drills treat it like any image row;
  `installFallbacks` leaves it out.
- Indexes `backups_tool (tool_id, kind, status, created_at DESC)`, `backups_version (version_id, kind, status)`, `backups_delete (delete_after)`

#### `mirror_pushes` (0024)
Purpose: every manifest a publisher pushed to the mirror with an `ot_` token, written by the mirror Worker.
- PK `id` TEXT · `repo` TEXT NN (`<namespace>/<name>`) · `digest` TEXT NN · `tag` TEXT (NULL for a push by digest)
- `user_id` TEXT → `users(id)` ON DELETE SET NULL · `token_id` TEXT · `size_bytes` INTEGER (of the manifest) · `created_at` INTEGER NN
- Read by the mirror for the 30-tags-an-hour limit and the rule on `sha256-*` tags, and by `queueMirrorSweeps`;
  `sweepMirrorRepo` deletes a repository's rows older than a week after sweeping it.
- Indexes `mirror_pushes_repo (repo, digest)`, `mirror_pushes_created (created_at)`

#### `restore_drills`
Purpose: a monthly restore drill (a random git bundle plus a random public mirrored image).
- PK `id` TEXT · `git_backup_id`, `image_backup_id` TEXT → `backups(id)`
- `token_hash` TEXT · `expires_at` INTEGER (6 h, `DRILL_TTL`)
- `status` TEXT NN default `'dispatched'` CHECK `('dispatched', 'pass', 'fail', 'expired')`
- `detail` TEXT · `created_at` INTEGER NN · `completed_at` INTEGER

### 2.11 Notifications

#### `notifications` (0003)
Purpose: a ledger of outgoing emails. Its unique key makes `sendEmail` idempotent.
- PK `id` TEXT · `idempotency_key` TEXT NN UNIQUE
- `to_email` TEXT NN (comma-joined) · `subject` TEXT NN · `kind` TEXT NN (free text: `rejected`, `published`, `in_review`, `alert`, ...)
- `status` TEXT NN CHECK `('sent', 'skipped', 'failed')` (no default)
- `error` TEXT · `created_at` INTEGER NN
- 0033: `body` TEXT and `headers_json` TEXT (the email, kept until it is sent or given up on) · `attempts` INTEGER NN DEFAULT 0 · `sent_at` INTEGER; partial index `notifications_retry (status, created_at) WHERE body IS NOT NULL`.
- Flow (`notify.ts:sendEmail`): inserted as `failed` ("not sent yet", with its text), or as `skipped` when `RESEND_API_KEY` is unset; `sent` once Resend accepts it. `retryEmails` (15-minute cron) tries failed rows again, five attempts over two days; a refused message (4xx other than 429) gets `attempts = 5` at once.

### 2.11a Inbox, notification settings and follows (0017, 0029, 0030, 0036)

- `email_prefs`: PK `user_id` → `users` (cascade); `community`, `owner_issues`, `releases` (0029), `lifecycle` and
  `security` (0036), each CHECK `('immediate', 'daily', 'off')` default `immediate`; `inbox_muted_json` (0036: the
  kinds kept out of the inbox list and its unread count, still written and emailed); `email_provider` (0036: the
  sign-in account whose address gets the emails, null for `users.email` or else the first account's); `updated_at`.
  Written by `PUT /me/notification-settings`, `PUT /me/email-prefs` and one-click unsubscribe.
- `inbox`: PK `id` (ULID), `user_id` → `users` (cascade), `kind` (free text: issue_opened, comment, status, moderation,
  role, proposal, release, lifecycle, security), `scope` CHECK `('community', 'owner_issues', 'releases', 'lifecycle',
  'security', 'account')` (which preference decides the email; 0029 rebuilt the table for `releases`, 0036 for
  `lifecycle` and `security`), `tool_id`, `issue_id`, `actor_id`, `summary`, `path`, `created_at`, `read_at`,
  `emailed_at`. Indexes `inbox_user (user_id, created_at DESC)`, `inbox_pending (created_at) WHERE emailed_at IS NULL`.
  Written by `inbox.ts:notify`, `notifyFollowers` and `notifyPackageFollowers`; delivered by `deliverInbox`.
- `package_follows` (0029): PK `(tool_id, user_id)`, both cascade, `created_at`; index `package_follows_user`. `level`
  (0036) CHECK `('all', 'releases', 'muted')` default `all`: `all` hears about new versions, lifecycle changes and
  security warnings, `releases` about new versions and security warnings, `muted` about nothing, even through a
  followed publisher or input type.
- `follows` (0030): PK `(user_id, kind, target)`, `user_id` cascade, `kind` CHECK `('publisher', 'input')`, `target`
  (a namespace's name, or an input type; no foreign key, so a follow outlives a renamed namespace), `created_at`; index
  `follows_target (kind, target)`. At most 200 a person (`PUT /me/follows/:kind/:target`).
- `versions.announced_at` (0029): set once, by `publishVersion` when the version first becomes the latest; only then
  are followers and open issues told.

### 2.12a Community (0016)

- `community_roles`: `user_id`, `role` (`triager` | `reviewer`, CHECK), `granted_by`, `note`, `granted_at`; PK
  `(user_id, role)`. Staff (`is_admin`, `is_reviewer`) hold both without a row.
- `issues`: per-package `number` (UNIQUE with `tool_id`, assigned as `MAX(number) + 1` in the insert), `kind`
  (broken | outdated | wrong_info | feature | question), `status` (open | confirmed | fixed | wont_fix | duplicate),
  `title`, `body_md`, `version`, `platform`, `engine` (docker | podman | native), `exit_code`, `author_id`,
  `author_kind` (user | system), `system_source`, `dedupe_key` (unique per tool when set), `duplicate_of`, `fixed_in`,
  `moderation` (visible | held | hidden), `hidden_reason`, `locked_at`, `deleted_at`, `edited_at`,
  `maintainer_replied_at`, `comment_count`, `me_too_count`, `created_at`, `last_activity_at`, `closed_at`, `closed_by`.
  Indexes `issues_tool`, `issues_board` (partial, visible), `issues_held` (partial), `issues_dedupe`.
- `issue_comments`: `issue_id`, `author_id`, `author_kind`, `role_badge` (maintainer | triager | staff, as it was when
  written), `body_md`, `moderation`, `hidden_reason`, `edited_at`, `deleted_at`, `created_at`.
- `confirmations`: `tool_id`, `version_id`, `user_id`, `result` (works | broken), `platform`, `engine`, `ot_version`,
  `issue_id`; UNIQUE `(version_id, user_id, platform)`.
- `run_signals`: anonymous daily counts of failed runs, PK `(version_id, day, platform, engine, exit_class)`.
- `problem_signals` (0032): anonymous daily counts from **Report a problem**, `kind` (broken | outdated), `platform`
  (`''` when unknown, and always for outdated), PK `(version_id, day, kind, platform)`. Broken counts are added to
  `run_signals` toward the version's unconfirmed issue; outdated counts are always against the latest version.
- `content_flags`: `target_kind` (issue | comment | request | request_comment, since 0026), `target_id`, `flagger_id`, `reason` (personal_data | spam | abuse |
  off_topic | other), `note`, `status` (open | upheld | dismissed); UNIQUE per target and flagger.
- `issue_subscriptions`: `(issue_id, user_id)` with `reason` (author, commented, confirmed, manual) and `muted`.
- `tools.open_broken` / `open_outdated` are kept by `community.ts:refreshCounts` in the same batch as every change.

### 2.12b Tool requests (0018)

- `tool_requests`: `number` (UNIQUE, `MAX(number) + 1` in the insert), `provider` (github | gitlab), `repo_path` (as
  the host spells it), `repo_key` (UNIQUE, `provider:lower(path)`), `project_id`, `url`, `description`, `license`,
  `upstream_stars`, `pushed_at`, `note` (plain text, 500 characters), `requested_by`, `status` (open | accepted |
  in_progress | published | declined), `decline_code` (license | archived | not_osint | not_cli | needs_login |
  acceptable_use | unmaintained | duplicate | withdrawn | other), `decision_note`, `decided_by`, `decided_at`,
  `tool_id` (the package that answers it), `otlite_name`, `dropped_reason` (from `known-repos.ts`), `vote_count`,
  `moderation` (visible | held | hidden), `hidden_reason`, `created_at`, `updated_at`. Indexes
  `tool_requests_board (status, vote_count DESC, number DESC)`, `tool_requests_project (provider, project_id)`,
  `tool_requests_requester (requested_by, created_at)`.
- `request_votes`: PK `(request_id, user_id)`, `created_at`; the requester's vote is added with the request.
  `vote_count` is recounted in the same batch as every vote.

### 2.12g Request discussions (0026)

- `request_comments`: `request_id` → `tool_requests(id)` (cascade), `author_id`, `author_kind` (user | system),
  `role_badge` (triager | staff, as it was when written; requests have no maintainers), `body_md`, `moderation`
  (visible | held | hidden), `hidden_reason`, `edited_at`, `deleted_at`, `created_at`. Written by
  `requests.ts:addRequestComment`; edited, deleted, flagged and moderated through `community.ts` with kind
  `request_comment`.
- `request_subscriptions`: PK `(request_id, user_id)`, `reason` (author | commented | manual), `muted`, `created_at`.
  The requester is added with the request; `inbox.ts:requestSubscribers` reads it.
- `tool_requests.comment_count` (visible replies, recounted by `community.ts:refreshRequestReplies` in the same batch as
  every change) and `locked_at` (set by a triager, or nightly by `lockStaleThreads` 30 days after a published or
  declined request's `updated_at`; replies move `updated_at`).

### 2.12f Bump pull requests (0022, 0028, 0031)

- `bump_prs`: PK `(tool_id, version)` (upstream's release; for `kind = 'dependency'` the pins it changes,
  `pkg==1.2,other==3.4`; for `kind = 'rebuild'` `rebuild:<12 hex of the base digest>`), `kind` (0031: upstream |
  dependency | rebuild), `pr_number` (0 for a rebuild, which has no pull request), `url`, `branch`, `status` (open | merged |
  released | failed | closed), `released_version` (the version the latest attempt releases), `merged_by` (null when
  the registry released it), `auto`, `merge_sha`, `merged_at` (the latest attempt), `run_url` (a failed release
  workflow run), `attempts`, `error_code`, `error`, `released_at`, `created_at`, `updated_at`. Written by
  `bumps.ts:maybeOpenBump`, `releaseBump`, `settleBump` and `maybeAutoRelease`, and `build-watch.ts` for the other kinds.
  A rebuild row is inserted already `merged`.
  - Transitions: open → merged (guarded, before GitHub is called; back to open when the merge fails) → released |
    failed; failed → merged (released again, no merge); open | failed → closed (superseded by a newer release, or
    closed on GitHub, seen by auto mode).
- `tools.auto_release` (0028): 1 (default) lets `UPSTREAM_WATCH=auto` release the package's pin-only bumps; maintainers
  switch it with `PUT /packages/:ns/:name/auto-release`.

### 2.12g Change proposals (0027)

- `change_proposals`: PK `id` (ULID), `tool_id` → `tools(id)` (cascade), `pr_number` NN (the pull request in the
  wrapper repository; UNIQUE with `tool_id`), `url`, `branch` (`otinstaller/proposal-<id>`), `proposer_id` → `users`
  (set null), `title`, `note` (plain text), `files_json` (`{path: content}` for `otinstaller.yaml`, `Dockerfile`,
  `README.md`), `version`, `builds` (0/1: the release workflow builds it, else a tag), `checks_json` (`[{code,
  message}]` for the reviewer), `status` (open | changes_requested | merged | rejected | withdrawn), `reviewer_id` →
  `users` (set null), `decision_note`, `decided_at`, `released_version`, `created_at`, `updated_at`. Indexes
  `change_proposals_status (status, updated_at DESC)`, `change_proposals_tool (tool_id, created_at DESC)`,
  `change_proposals_proposer (proposer_id, status)`. Written by `proposals.ts`.
- A new version's first-week counts (`first-week.ts`) are read from `confirmations`; nothing new is stored.

### 2.12e Upstream watch (0021)

- `upstream_watch`: PK `tool_id` → `tools(id)` (cascade), `provider`, `upstream_path`, `pin_kind` (an
  `upstream-pin.ts` kind, `pipx`, `image`, an override's kind, or `none`), `pinned`, `pin_package` (the PyPI project
  or crate a pip or cargo pin names), `pinned_version_id` (the version the Dockerfile was read at), `latest`,
  `latest_at`, `commits_behind` (commit pins), `state` (current | behind | unknown | archived | gone |
  license_changed | renamed | error), `upstream_license`, `releases_etag`, `override_json`, `error`, `checked_at`,
  `changed_at` (when the state or latest release last changed). Written only by `upstream.ts:checkUpstream` and the
  staff override route.

### 2.12h Build watch (0031)

- `dependency_watch`: PK `(tool_id, ecosystem, package)`, `tool_id` → `tools(id)` (cascade), `ecosystem` CHECK
  `('pypi')`, `package` (as requirements.txt writes it), `pinned`, `latest`, `latest_at`, `state` (current | behind |
  unknown | error), `error`, `pinned_version_id` (the version requirements.txt was read at), `checked_at`,
  `changed_at`. Rewritten whole for a tool by `build-watch.ts:checkDependencies`; only tools with
  `community_packaged = 0`.
- `base_images`: PK `image` (`<repo>:<tag>` on Docker Hub, e.g. `library/python:3.12-slim`), `digest` (kept when a
  lookup fails), `error`, `checked_at`, `changed_at`. Looked up again after 20 hours, so one night shares one lookup.
- `base_watch`: PK `tool_id` → `tools(id)` (cascade), `image` (the last `FROM`), `built_digest` (the digest when the
  version was first seen), `latest_digest`, `pinned_version_id`, `state` (current | updated | unknown | error),
  `error`, `rebuilt_at`, `checked_at`, `changed_at`. Written by `build-watch.ts:checkBaseImage` and `maybeRebuild`.

### 2.12d Community submissions (0020)

- `tools.needs_first_review`: a community submission's tool; its next scanned version waits in `awaiting_review` even
  in an active namespace, until a reviewer publishes it. `tools.submitted_by` → `users(id)`; `tools.upstream_url`: the
  project a community wrapper packages (set by `record()` for new wrappers, backfilled by 0020).
- `tool_maintainers`: PK `(tool_id, user_id)`, `reason` (`submitter` | `added`), `added_by`, `created_at`.
- `wrapper_submissions`: `number` (UNIQUE), `user_id`, `import_id`, `request_id`, `provider`, `upstream_path`,
  `upstream_key` (`provider:lower(path)`), `upstream_url`, `name`, `runtime` (docker | pipx), `builds`,
  `manifest_json`, `dockerfile`, `checks_json` (`{flags, dockerfile}`), `template_conformant`, `status` (submitted |
  releasing | in_review | changes_requested | published | rejected | withdrawn | failed), `wrapper_repo`,
  `wrapper_repo_id` (the GitHub repository ID `record()` matches), `released_version`, `tool_id`, `reviewer_id`,
  `decision_note`, `error`, `created_at`, `updated_at`.

### 2.12c Contributor profiles (0019)

- `contributor_stats`: PK `user_id` → `users(id)` (cascade), `issues_opened`, `issues_confirmed` (their broken,
  outdated and wrong_info issues now confirmed or fixed), `replies`, `confirmations`, `requests_made`,
  `requests_published`, `issues_triaged` (other people's issues they closed), `updated_at`. Only visible, undeleted
  posts by people (not the registry) count. Written only by `people.ts:refreshContributorStats` (nightly).
- Indexes for profiles: `issues_author (author_id, created_at DESC)`, `issue_comments_author`, `confirmations_user`,
  `issues_closed_by`.

### 2.12 Feedback (0012)

#### `feedback`
Purpose: beta feedback from the site form and `ot feedback`.
- PK `id` TEXT · `user_id` TEXT → `users(id)`
- `kind` TEXT NN CHECK `('bug', 'idea', 'question', 'other')`
- `message` TEXT NN · `email` TEXT · `page` TEXT · `client` TEXT
- `source` TEXT NN CHECK `('web', 'cli')`
- `status` TEXT NN default `'open'` CHECK `('open', 'done', 'dismissed')`
- `note` TEXT · `resolved_by` TEXT → `users(id)` · `resolved_at` INTEGER · `created_at` INTEGER NN
- Index `feedback_queue (status, created_at)`

### 2.13 Rate limits (0009)

#### `rate_limits`
Purpose: fixed-window counters, for example anonymous reports (5 per hour per IP) and install pings (one per address,
version and day, so `install_counts` can't be inflated). The nightly cron purges windows older than a day.
- PK `(key, window_start)` · `key` TEXT NN (a salted hash, never the raw IP) · `window_start` INTEGER NN · `count` INTEGER NN default 0
- Written by `trust.ts` with `INSERT ... ON CONFLICT`.

### 2.13a IndexNow queue (0037)

#### `indexnow_queue`
Purpose: paths on `SITE_URL` that a release, yank, deprecation, takedown or transfer changed, waiting to be sent to
IndexNow (`indexnow.ts`). One row per path, so a page changed twice between runs is sent once.
- PK `path` TEXT · `queued_at` INTEGER NN (the latest change) · index `idx_indexnow_queue_queued (queued_at)`
- Written with `INSERT ... ON CONFLICT (path) DO UPDATE` by `scans.ts:publishVersion` (when a version is announced),
  `trust.ts` (`setYanked`, `setDeprecated`, `clearDeprecated`, `removeVersion`) and `transfers.ts:completeTransfer`,
  only while `INDEXNOW_KEY` is set and `SITE_URL` is a public https origin.
- Emptied by `indexnow.ts:flushIndexNow` on every cron run: up to 500 rows a run; rows sent (200/202) or refused for
  good (400/422) are deleted unless re-queued since; rows older than 7 days are dropped.

### 2.14 Audit

#### `audit_log`
Purpose: an append-only record of every state change, written in the same `db.batch` as the change via `audit(...)`.
- PK `id` TEXT
- `actor_id` TEXT (no FK) · `actor_kind` TEXT NN CHECK `('user', 'system', 'github', 'gitlab')`
- `action` TEXT NN (for example `publish.scanning`, `namespace.approve`, `transfer.complete`)
- `target_kind` TEXT NN · `target_id` TEXT NN · `metadata_json` TEXT · `created_at` INTEGER NN
- Index `audit_log_created (created_at DESC)` (0009)

### 2.15 Search (FTS)

#### `tools_fts` (virtual, FTS5)
Purpose: full-text search over packages.
- Columns `namespace, name, summary, tags, body`; `content = ''` (contentless), `contentless_delete = 1`, `tokenize = 'porter unicode61'`
- `rowid` = `tools.rowid`. `namespace` is the namespace **name**, looked up from `namespaces` inside the trigger. `body` = `tools.readme_text`.
- Maintained only by the three triggers on `tools`. Renaming a namespace does **not** refresh it, because the update trigger only fires on changes to `tools` columns.

---

## 3. Status state machines

The values are the CHECK sets above (or the observed values where there is no CHECK). Transitions are listed as `file:function`.

### 3.1 `publish_jobs.status` (no CHECK)
Values in use: `queued`, `validating`, `scanning`, `rejected`, `awaiting_review`, `published`, `error`.

| Transition | Where |
| --- | --- |
| (insert) → `queued` | `routes/webhooks.ts:onTag` (GitHub tag push); `sync.ts:queueTag` (GitLab tags and polls). Both use `ON CONFLICT (delivery_id) DO NOTHING`. |
| `queued`/`validating` → `validating` (attempts+1) | `publish.ts:processJob` |
| `validating` → `scanning` or `rejected` | `publish.ts:record` (called from `processJob`; `rejected` when there are any problems) |
| `scanning` → `rejected` | `scans.ts:applyScanResults` (verdict fail); `guides.ts:settle` (`content_link_malicious`) |
| `scanning` → `awaiting_review` | `scans.ts:applyScanResults` (namespace not active); `guides.ts:settle` (namespace not active, or PII hits) |
| `scanning`/`awaiting_review` → `published` | `scans.ts:publishVersion` (from `applyScanResults`, `guides.ts:settle`, `routes/review.ts` `POST /admin/versions/:id/approve`, and the `{ publishVersionId }` queue messages sent by `POST /admin/namespaces/:ns/approve`) |
| `awaiting_review` → `rejected` | `routes/review.ts` `POST /admin/versions/:id/reject` |
| `queued`/`validating`, or `scanning` that was never dispatched → `error` (`internal_error`) | `publish.ts:failJob` (transient retries used up) |
| `scanning` → `error` (`scan_timeout`) | `scans.ts:expireStaleScans` |

Note: namespace `request-changes` and `reject` (`routes/review.ts`) set the waiting *versions* to `rejected` but leave their publish_jobs at `awaiting_review`.

### 3.2 `versions.status`
CHECK: `received`, `validating`, `scanning`, `awaiting_review`, `published`, `rejected`, `yanked`, `removed`.
**`received` and `validating` are never written by `api/src`.** A version row is first inserted (or upserted, which
reuses a rejected row) by `publish.ts:record` as `scanning` or `rejected`.

| Transition | Where |
| --- | --- |
| (insert/upsert) → `scanning` / `rejected` | `publish.ts:record` |
| `scanning` → `rejected` (`rejected_reason` = verdict code) | `scans.ts:applyScanResults` |
| `scanning` → `rejected` (`content_link_malicious`) | `guides.ts:settle` |
| `scanning` → `rejected` (`scan_timeout`) | `scans.ts:expireStaleScans` |
| `scanning` (not dispatched) → `rejected` (`internal_error`) | `publish.ts:failJob` |
| `scanning` → `awaiting_review` | `scans.ts:applyScanResults`, `guides.ts:settle` |
| `scanning`/`awaiting_review` → `published` (sets `published_at`) | `scans.ts:publishVersion` |
| `awaiting_review` → `rejected` (`review_rejected`) | `routes/review.ts` `POST /admin/versions/:id/reject` |
| `awaiting_review` → `rejected` (`submission_withdrawn`) | `submissions.ts:withdrawSubmission` (`POST /submissions/:n/withdraw`) |
| `awaiting_review` → `rejected` (`changes_requested`) | `routes/review.ts` `POST /admin/namespaces/:ns/request-changes` |
| `awaiting_review` → `rejected` (`namespace_rejected`) | `routes/review.ts` `POST /admin/namespaces/:ns/reject` |
| `published` ↔ `yanked` (sets or clears `yanked_at`) | `trust.ts:setYanked` |
| any except `rejected`/`removed` → `removed` | `trust.ts:removeVersion` (one version, or every version of the tool) |

`versions.scan_status` (`pending` → `pass`/`warn`/`fail`): reset to `pending` by `publish.ts:record`'s upsert, then set
by `scans.ts:applyScanResults` and `guides.ts:settle`.

### 3.3 `namespaces.status`
`pending_review`, `active`, `rejected`, `suspended`.

| Transition | Where |
| --- | --- |
| (insert) → `pending_review` | `routes/webhooks.ts:namespaceFor` (GitHub), `routes/sources.ts:gitlabNamespace` (GitLab) |
| `pending_review` → `active` | `routes/review.ts` `POST /admin/namespaces/:ns/approve` (then queues `{ publishVersionId }` for each waiting version) |
| `pending_review` → `pending_review` (notes only) | `routes/review.ts` `POST /admin/namespaces/:ns/request-changes` |
| `pending_review` → `rejected` | `routes/review.ts` `POST /admin/namespaces/:ns/reject` |
| any → `suspended` | `routes/review.ts` `POST /admin/namespaces/:ns/suspend`; `trust.ts:removeVersion` with `suspend` |

No code path in `api/src` moves a namespace out of `rejected` or `suspended`. `verified` is set to 1 by `POST /admin/namespaces/:ns/verify`.

### 3.4 `scans`
Rows are insert-only, with `result` set at insert (`pass`/`warn`/`fail`): `scans.ts:applyScanResults` (signature, vuln,
malware, smoke, sbom) and `guides.ts:settle` (links, pii). There is no status column.

### 3.5 `imports.status`
`detecting`, `draft`, `ready`, `finished`, `failed`.

| Transition | Where |
| --- | --- |
| (insert) → `detecting` | `imports.ts:startImports` |
| `detecting` → `draft` / `ready` (draft when it has problems) | `imports.ts:saveDetection` (via `detectQueued`) |
| `detecting` → `failed` | `imports.ts:failImport` (guarded by `AND status = 'detecting'`) |
| `draft`/`ready` → `draft`/`ready` | `imports.ts:editImport` |
| `draft`/`ready` → `finished` | `imports.ts:finishImport` (pr, registry, connect), `imports.ts:finishWrapper` (wrapper) |

### 3.6 `backup_runs.status` and `backups.status`

`backup_runs`:

| Transition | Where |
| --- | --- |
| (insert) → `pending` | `backups.ts:createRun` (from `releasePlan`, weekly, manual) |
| `pending` → `dispatched` / `failed` | `backups.ts:dispatchBackups` |
| `pending`/`dispatched` → `completed` (token cleared) | `backups.ts:completeRun` |
| `pending`/`dispatched` → `expired` | `backups.ts:expireRuns` |

`backups`:

| Transition | Where |
| --- | --- |
| (insert) → `pending` | `backups.ts:createRun` |
| `pending` → `failed` | `backups.ts:dispatchBackups` (dispatch failed), `backups.ts:expireRuns` |
| `pending` → `stored` / `too_large` / `failed` | `backups.ts:completeRun` (checks the R2 object size and the wheel SHA-256, or `imageExists`) |
| `stored` → `deleted` | `backups.ts:pruneWeekly` (keeps the latest 4 weekly bundles); `backups.ts:deleteBackup` (via `purgeBackups` once `delete_after` has passed) |

`delete_after` is set by `scheduleDeletion` (takedown) and `setGitBackups` (opt-out), and cleared by `setLegalHold` and by `setGitBackups(enabled)`.

`restore_drills`: (insert) → `dispatched` in `backups.ts:startDrill`; → `pass`/`fail`/`expired` in `backups.ts:finishDrill`,
called by `startDrill` (dispatch failed → `fail`), `completeDrill` and `expireDrills`.

### 3.7 `transfers.status`
`pending`, `verified`, `accepted`, `completed`, `declined`.

| Transition | Where |
| --- | --- |
| (insert) → `pending` (claim) | `transfers.ts:startClaim` (re-running a claim resets an existing `pending`/`verified` claim to `pending`) |
| (insert) → `pending` (transfer) | `transfers.ts:offerTransfer` |
| claim `pending`/`verified` → `verified` | `transfers.ts:verifyClaim` (a failure only sets `verification_error`) |
| transfer `pending` → `accepted` | `transfers.ts:acceptTransfer` (which then calls `completeTransfer`) |
| claim `verified` / transfer `accepted` → `completed` | `transfers.ts:completeTransfer` |
| `pending`/`verified`/`accepted` → `declined` | `transfers.ts:declineTransfer`; `completeTransfer` declines competing open rows for the same tool |

Claims never use `accepted`, and transfers never use `verified`.

### 3.8 `reports.status`
`open` (insert default, `trust.ts`) → `actioned` / `dismissed` in `routes/trust.ts` `POST /admin/reports/:id/resolve`.
There is no guard on the current status, so a resolved report can be resolved again.

### 3.8a `tool_requests.status`

| Transition | Where |
| --- | --- |
| (new) → `open`, or `declined` at once (`license`, `archived`) | `requests.ts:createRequest` |
| `declined` (`withdrawn`) → `open` when someone asks again | `requests.ts:createRequest` |
| `open` ↔ `accepted` → `in_progress` → `published`; any active → `declined`; `declined` → `open` | `requests.ts:setRequestStatus` (triagers and staff; the requester may withdraw) |
| any but `published` → `published` | `requests.ts:linkPublished` (from `scans.ts:publishVersion`) |

### 3.8b `wrapper_submissions.status`

| Transition | Where |
| --- | --- |
| (new) → `submitted`, then → `releasing` when the Dockerfile is conformant or there is nothing to build | `submissions.ts:submitWrapper` |
| `submitted` → `releasing` | `startSubmission` (a reviewer) |
| `releasing` → `in_review` (scans passed) or `failed` (scan rejected) | `firstReleaseScanned` (from `applyScanResults`) |
| `in_review` → `published` | `approveSubmission` → `publishVersion` → `firstReleasePublished` |
| open → `changes_requested` / `rejected` | `decideSubmission` |
| open → `withdrawn` | `withdrawSubmission` |
| `submitted` / `changes_requested` / `failed` → `submitted` or `releasing` | `updateSubmission` (the submitter) |

### 3.8c `change_proposals.status`

| Transition | Where |
| --- | --- |
| (new) → `open` | `proposals.ts:createProposal` |
| `open` → `changes_requested` | `reviewProposal` (a reviewer, never the proposer) |
| `open` / `changes_requested` → `open` | `updateProposal` (the proposer) |
| `open` → `merged` (the pull request merged and the release started) | `reviewProposal` approve |
| `open` / `changes_requested` → `rejected` | `reviewProposal` reject |
| `open` / `changes_requested` → `withdrawn` | `withdrawProposal` (the proposer or an admin) |

### 3.9 Others
- **`feedback.status`**: `open` (insert, `routes/beta.ts`) ↔ `done` / `dismissed` / `open` in `routes/beta.ts`
  `POST /admin/feedback/:id/resolve` (reopening clears `resolved_by`/`resolved_at`).
- **`device_logins.status`**: `pending` (insert, `routes/device.ts`) → `authorized` (`device.ts:authorizeDevice`) →
  `approved`/`denied` (`POST /auth/osintverse/device/confirm`) → `consumed` (`device.ts:pollOsintverseDevice`, from
  `approved`); `pending` → `denied` in `routes/auth.ts:osintverseCallback`.
- **`tools.status`**: `active` ↔ `deprecated` (`routes/trust.ts` `POST`/`DELETE /tools/:ns/:name/deprecate`;
  `sync.ts:applyMeta` for archived repos, using a fixed `ARCHIVED_MESSAGE`) → `removed` (`trust.ts:removeVersion`, whole tool).
- **`tools.health_status`**: set by `community.ts:healthSet`, inside `refreshCounts` (every confirmation, issue create,
  status or moderation change, and `scans.ts:latestMetadata` when the latest version changes) and nightly
  `refreshAllHealth`. `broken` while the tool has an open (`open`/`confirmed`, visible, not deleted) broken issue, or
  while at least 2 "broken" confirmations of the latest version in the last 30 days outnumber the "works" ones;
  else `healthy` when there is at least one "works"; else `unknown`.
- **`sources.sync_status`**: → `unavailable` / `transfer_pending` / `ok` in `sync.ts:applyMeta`; → `error` / `paused` in
  `sync.ts:pollSource`; → `paused` in `routes/sources.ts` `DELETE /sources/:id` and `transfers.ts:completeTransfer`
  (claims); → `ok` in `routes/sources.ts:switchSource`.
- **`page_links.status`**: `pending` → `ok`/`dead`/... and leftovers → `unchecked` (`guides.ts`, link checks);
  → `malicious` from the URL Scanner verdict; `ok`/`dead`/`unchecked` → `pending` again for the nightly recheck.
- **`notifications.status`**: see 2.11.

---

## 4. Conventions and exceptions

Observed conventions:
- **IDs** are TEXT ULIDs from `lib/crypto.ts:ulid(now)`.
- **Timestamps** are INTEGER Unix milliseconds (`Date.now()`); expiries are `now + TTL` in ms.
- **Booleans** are INTEGER 0/1 (`is_admin`, `verified`, `community_packaged`, `archived`, `weekly`, `git_backups`,
  `legal_hold`, `needs_update`, `required`, `community`).
- **JSON columns** end in `_json`: `manifest_json`, `registry_manifest_json`, `draft_manifest_json`, `detection_json`,
  `problems_json`, `summary_json`, `metadata_json`, `toc_json`.
- Enums are CHECK constraints. Changing one means rebuilding the table, as 0004 (`sources`) and 0010 (`accounts`) do.
- Only hashes of tokens are stored: `token_hash`, `scan_token_hash`, `claim_token_hash`, `device_code_hash`,
  `confirm_token_hash`, `webhook_secret_hash`.

Exceptions:
- **JSON without the `_json` suffix**: `tools.categories`, `tools.tags`, `installations.repo_ids`, `sources.topics`,
  `sources.baseline_tags`.
- **Comma lists, not JSON**: `api_tokens.scopes` (`'read,publish,manage,feedback'`), `accounts.scopes`,
  `notifications.to_email`.
- **Non-ULID keys**: composite PKs on `namespace_members`, `tool_io`, `tool_secrets`, `tool_guides`, `stars`,
  `install_counts`, `install_clients` (day + client), `aliases` (name-based), `rate_limits` (hash + window).
- **Seed IDs are deterministic, not ULIDs**: `ns_dheeraj`, `tool_<ns>_<name>`, `ver_<ns>_<name>_<version>`, `src_<name>`.
  Tests also insert `ot_test_<id>` tokens.
- **Not milliseconds**: `install_counts.day` and `install_clients.day` are TEXT `YYYY-MM-DD`; `rate_limits.window_start` is the window start.
- **Provider IDs stored as INTEGER, without an FK**: `installations.github_installation_id`,
  `publish_jobs.installation_id`, `sources.installation_id`.
- **Missing FKs**: `tools.latest_version_id` and `audit_log.actor_id` have none.
- **REAL**: `tools.dead_link_ratio`.
- **Status columns with no CHECK**: `publish_jobs.status` and `sync_events.status`.
- **Nullable timestamps** added by `ALTER` (SQLite can't add NOT NULL without a default): `installations.created_at`,
  `sources.created_at`, `publish_jobs.updated_at`, `transfers.updated_at`.
- **Unused CHECK values**: `versions.status` `received` and `validating`.

---

## 5. Migrations and seed in tests and local dev

**Local dev** (`api/package.json`):
- `npm run db:migrate` runs `wrangler d1 migrations apply otinstaller --local`.
- `npm run db:seed` runs `node scripts/seed.mjs && wrangler d1 execute otinstaller --local --file=.wrangler/seed.sql`.
  `seed.mjs` writes `DELETE FROM` for `aliases, tool_guides, tool_secrets, sources, tool_io, install_counts, versions,
  tools, namespaces` (in that order), then the statements from `buildSeedStatements()`.
- Production uses `npx wrangler d1 migrations apply otinstaller --remote`, only when asked. Production is never seeded.

**Tests** (`api/vitest.config.ts` + `api/test/setup.ts`):
- `readD1Migrations("./migrations")` is passed as the `TEST_MIGRATIONS` binding, and `buildSeedStatements()` as `TEST_SEED`.
  The spec fixtures and templates are also passed in, with fake secrets and `EDGE_CACHE: "off"`.
- `setup.ts` runs `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`, then, only if `tools` is empty, runs every seed
  statement in one `env.DB.batch`.
- Signed-in users are not seeded. Tests insert users and tokens directly.

**What `scripts/seed-lib.mjs` inserts** (`now = Date.UTC(2026, 9, 1)`; each manifest is validated against `spec/schema/v1.json` with Ajv first):
- **Users**: none.
- **Namespaces** (5):

| ID | Provider | Name | Kind | Status | Verified |
| --- | --- | --- | --- | --- | --- |
| `ns_dheeraj` | github | `dheeraj` | user | active | 0 |
| `ns_osintverse` | github | `osintverse` | org | active | 1 |
| `ns_community` | registry | `osintverse-community` | org | active | 1 |
| `ns_newbie` | github | `newbie` | user | pending_review | 0 |
| `ns_sigstore` | github | `sigstore` | org | active | 1 |

- **Tools** (11) and their versions (13 version rows). `scan_status` is `pass` for all of them; the latest version is
  `published`.

| Package | Source | Versions | Notes |
| --- | --- | --- | --- |
| `dheeraj/holehe-lite` | fixture `docker-tool.yaml` | 1.0.0 `removed`, 1.1.0 and 1.2.0 `published` | 1.0.0 removed for a malicious dependency; has `repo_url` |
| `osintverse/phone-parse` | fixture `pipx-tool.yaml` | 0.3.1 | |
| `dheeraj/email-investigation-playbook` | fixture `guide.yaml` | 1.0.0 | guide, related to holehe-lite |
| `osintverse-community/sherlock` | inline | 0.15.0 | community |
| `osintverse/email-header-parser` | inline | 1.0.0 | |
| `dheeraj/whois-lite` | inline | 2.0.0 | registry-held manifest |
| `dheeraj/old-username-scraper` | inline | 0.9.0 | `broken`, secret `FORUM_API_KEY` |
| `osintverse-community/tldextract` | `examples/tldextract` | 5.4.0 | community, real wheel |
| `sigstore/cosign` | `examples/cosign` | 3.1.3 | real Sigstore signer |
| `sigstore/cosign-wrong-signer` | copy of cosign | 3.1.3 | recorded signer `attacker@example.com` |
| `newbie/secret-tool` | inline | 0.1.0 | namespace still pending review, health `unknown` |

- **Also**:
  - `tool_io` rows (entity inputs, topics, outputs) and `tool_secrets` (the one secret above).
  - One `sources` row, `src_whois-lite` (`manifest_mode = 'registry'`).
  - One `tool_guides` row (playbook → holehe-lite).
  - One `aliases` row: `osintverse-community/holehe` → holehe-lite.
  - Install and star counts are set directly on `tools`.
  - `tools_fts` is filled by the insert trigger. Namespaces are inserted first, so the namespace lookup resolves.
