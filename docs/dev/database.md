# Registry database (Cloudflare D1)

Reference for the `otinstaller` D1 database used by the registry API (`api/`). Everything below is derived from
`api/migrations/*.sql` and the code in `api/src/`, `api/test/` and `api/scripts/`.

- Binding: `DB`, database name `otinstaller`, `migrations_dir: "migrations"` (`api/wrangler.jsonc`).
- 13 migrations, `0001` to `0013`.
- Final schema: **34 regular tables + 1 FTS5 virtual table (`tools_fts`)** = 35. FTS5 also creates its own shadow
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
| 0016 | `0016_community.sql` | `users` + `handle` (unique, backfilled from `lower(login)`, a suffix on collision), `profile_hidden`, `posting_blocked_until`; new tables `community_roles`, `issues`, `issue_comments`, `confirmations`, `run_signals`, `content_flags`, `issue_subscriptions`; `health_checks` + `failure_class`; `tools` + `open_broken`, `open_outdated`. |
| 0017 | `0017_notifications.sql` | New tables `email_prefs` (per person: `community`, `owner_issues` as immediate/daily/off) and `inbox` (kind, scope community/owner_issues/account, summary, site path, read and emailed times); indexes `inbox_user`, `inbox_pending` (partial). |
| 0018 | `0018_requests.sql` | New tables `tool_requests` (one per repository: status, decline code, decision, the answering package, what otlite and the seed survey knew, votes, moderation) and `request_votes`; indexes `tool_requests_board`, `tool_requests_project`, `tool_requests_requester`, `request_votes_user`. |
| 0019 | `0019_people.sql` | New table `contributor_stats` (per person: issues opened and confirmed, replies, confirmations, requests made and published, issues triaged; recounted nightly); indexes `issues_author`, `issue_comments_author`, `confirmations_user`, `issues_closed_by`. |

---

## 2. Final schema, by area

Notation: `TEXT`/`INTEGER`/`REAL` are the declared SQLite types. "ms" means a Unix-millisecond timestamp. NN means
NOT NULL. Defaults are listed where they exist.

### 2.1 Identity and auth

#### `users`
Purpose: one person on the registry. Rows are created at first sign-in (`routes/auth.ts`).
- PK `id` TEXT (ULID)
- `login` TEXT NN · `name`, `email`, `avatar_url` TEXT
- `is_admin` INTEGER NN default 0 · `is_reviewer` INTEGER NN default 0 (staff flags, 0/1)
- `banned_at` INTEGER (ms; set by the ban route in `routes/trust.ts`)
- `created_at` INTEGER NN (ms)
- No CHECKs, no extra indexes.

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
- Audit: `token.create`, `token.revoke` and `token.write` (every successful write made with a token) rows in
  `audit_log`

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
- `health_status` TEXT NN default `'unknown'` CHECK `('unknown', 'healthy', 'broken', 'not_checked')`
- `health_fail_streak` INTEGER NN default 0 · `health_checked_at` INTEGER (0009)
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
- `changelog` TEXT (0004) · `search_text` TEXT (0007; plain text copied to `tools.readme_text` when it becomes latest)
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
Purpose: one attempt to publish a tag (from a webhook, a poll or an import).
- PK `id` TEXT · `delivery_id` TEXT NN UNIQUE (dedup key)
- `provider` TEXT NN · `repo` TEXT NN · `tag` TEXT NN
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

### 2.6 Scans, review and health

#### `scans`
Purpose: one check result for a version (scanner callback for tools, Worker content checks for guides).
- PK `id` TEXT · `version_id` TEXT NN → `versions(id)` ON DELETE CASCADE
- `kind` TEXT NN CHECK `('signature', 'vuln', 'malware', 'smoke', 'sbom', 'links', 'pii')`
- `result` TEXT NN CHECK `('pass', 'warn', 'fail')`
- `summary_json` TEXT · `report_r2_key` TEXT · `ran_at` INTEGER NN

Review has no table of its own: it uses `namespaces.status/reviewed_*`, `versions.status = 'awaiting_review'` and `audit_log`.

#### `health_checks`
Purpose: nightly health-check results. `applyHealth` keeps the latest 30 per tool.
- PK `id` TEXT · `tool_id` TEXT NN → `tools(id)` ON DELETE CASCADE · `version_id` TEXT NN → `versions(id)`
- `result` TEXT NN CHECK `('pass', 'fail')` · `duration_ms` INTEGER · `error_excerpt` TEXT · `ran_at` INTEGER NN
- Index `health_checks_tool (tool_id, ran_at DESC)` (0009)

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
- Indexes `backups_tool (tool_id, kind, status, created_at DESC)`, `backups_version (version_id, kind, status)`, `backups_delete (delete_after)`

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
- Flow (`notify.ts:sendEmail`): inserted as `sent`, or as `skipped` when `RESEND_API_KEY` is unset; set to `failed` if Resend answers with an error.

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
- `content_flags`: `target_kind` (issue | comment), `target_id`, `flagger_id`, `reason` (personal_data | spam | abuse |
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

### 3.9 Others
- **`feedback.status`**: `open` (insert, `routes/beta.ts`) ↔ `done` / `dismissed` / `open` in `routes/beta.ts`
  `POST /admin/feedback/:id/resolve` (reopening clears `resolved_by`/`resolved_at`).
- **`device_logins.status`**: `pending` (insert, `routes/device.ts`) → `authorized` (`device.ts:authorizeDevice`) →
  `approved`/`denied` (`POST /auth/osintverse/device/confirm`) → `consumed` (`device.ts:pollOsintverseDevice`, from
  `approved`); `pending` → `denied` in `routes/auth.ts:osintverseCallback`.
- **`tools.status`**: `active` ↔ `deprecated` (`routes/trust.ts` `POST`/`DELETE /tools/:ns/:name/deprecate`;
  `sync.ts:applyMeta` for archived repos, using a fixed `ARCHIVED_MESSAGE`) → `removed` (`trust.ts:removeVersion`, whole tool).
- **`tools.health_status`**: `ops.ts:applyHealth` (→ `healthy` on a pass, → `broken` after 3 failures in a row);
  `scans.ts:latestMetadata` (→ `not_checked` with no test input, `not_checked` → `unknown` once there is one).
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
- **Not milliseconds**: `install_counts.day` and `install_clients.day` are TEXT `YYYY-MM-DD`; `rate_limits.window_start` is the window start;
  `health_checks.duration_ms` is a duration.
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
| `dheeraj/email-investigation-playbook` | fixture `guide.yaml` | 1.0.0 | guide, `not_checked`, related to holehe-lite |
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
