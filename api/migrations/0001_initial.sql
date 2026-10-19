-- OTInstaller Registry: initial schema. The plan's 24 tables plus tool_secrets, which powers the "no API keys needed" filter.
-- IDs are ULIDs; timestamps are Unix milliseconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_reviewer INTEGER NOT NULL DEFAULT 0,
  banned_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  provider_user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  scopes TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'read',
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE namespaces (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'registry')),
  provider_owner_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'org', 'group')),
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'active', 'rejected', 'suspended')),
  verified INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  review_notes TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_owner_id)
);

CREATE TABLE namespace_members (
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'publisher')),
  PRIMARY KEY (namespace_id, user_id)
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  github_installation_id INTEGER NOT NULL UNIQUE,
  namespace_id TEXT REFERENCES namespaces(id),
  repo_ids TEXT NOT NULL DEFAULT '[]',
  suspended_at INTEGER
);

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id),
  kind TEXT NOT NULL DEFAULT 'tool' CHECK (kind IN ('tool', 'guide')),
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  repo_url TEXT,
  latest_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'removed')),
  deprecated_message TEXT,
  community_packaged INTEGER NOT NULL DEFAULT 0,
  stars_count INTEGER NOT NULL DEFAULT 0,
  installs_30d INTEGER NOT NULL DEFAULT 0,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'broken', 'not_checked')),
  readme_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (namespace_id, name)
);
CREATE INDEX tools_status_installs ON tools (status, installs_30d DESC);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  version TEXT NOT NULL,
  semver_major INTEGER NOT NULL,
  semver_minor INTEGER NOT NULL,
  semver_patch INTEGER NOT NULL,
  semver_pre TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  runtime_kind TEXT,
  artifact_ref TEXT,
  git_sha TEXT,
  signer_identity TEXT,
  signer_issuer TEXT,
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'pass', 'warn', 'fail')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN
    ('received', 'validating', 'scanning', 'awaiting_review', 'published', 'rejected', 'yanked', 'removed')),
  removed_reason TEXT,
  yanked_at INTEGER,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (tool_id, version)
);
CREATE INDEX versions_tool_status ON versions (tool_id, status, published_at DESC);

CREATE TABLE tool_io (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  type TEXT NOT NULL,
  PRIMARY KEY (tool_id, direction, type)
);
CREATE INDEX tool_io_lookup ON tool_io (direction, type, tool_id);

CREATE TABLE tool_secrets (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  required INTEGER NOT NULL,
  PRIMARY KEY (tool_id, name)
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL UNIQUE REFERENCES tools(id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  project_id TEXT NOT NULL,
  url TEXT NOT NULL,
  default_branch TEXT,
  manifest_mode TEXT NOT NULL DEFAULT 'repo' CHECK (manifest_mode IN ('repo', 'registry')),
  registry_manifest_json TEXT,
  webhook_id TEXT,
  webhook_secret_hash TEXT,
  etag TEXT,
  last_event_at INTEGER,
  last_poll_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'ok' CHECK (sync_status IN ('ok', 'paused', 'error')),
  last_error TEXT,
  UNIQUE (provider, project_id)
);

CREATE TABLE sync_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('tag', 'release', 'push', 'repo', 'poll', 'manual')),
  payload_summary TEXT,
  status TEXT NOT NULL,
  error TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX sync_events_source ON sync_events (source_id, received_at DESC);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  project_id TEXT NOT NULL,
  detected_kind TEXT,
  draft_manifest_json TEXT,
  finish_mode TEXT CHECK (finish_mode IN ('pr', 'registry')),
  pr_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE publish_jobs (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  repo TEXT NOT NULL,
  tag TEXT NOT NULL,
  version_id TEXT REFERENCES versions(id),
  status TEXT NOT NULL,
  error_code TEXT,
  error_detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX publish_jobs_status ON publish_jobs (status, created_at);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('signature', 'vuln', 'malware', 'smoke', 'sbom', 'links', 'pii')),
  result TEXT NOT NULL CHECK (result IN ('pass', 'warn', 'fail')),
  summary_json TEXT,
  report_r2_key TEXT,
  ran_at INTEGER NOT NULL
);

CREATE TABLE health_checks (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  duration_ms INTEGER,
  error_excerpt TEXT,
  ran_at INTEGER NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  r2_key TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  dead_links INTEGER NOT NULL DEFAULT 0,
  UNIQUE (version_id, path)
);

CREATE TABLE tool_guides (
  guide_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  PRIMARY KEY (guide_id, tool_id)
);

CREATE TABLE stars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tool_id)
);

CREATE TABLE install_counts (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, version_id, day)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  version_id TEXT REFERENCES versions(id),
  reporter_id TEXT REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('malware', 'policy', 'impersonation', 'license', 'broken', 'other')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by TEXT REFERENCES users(id),
  resolution_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_queue ON reports (status, created_at);

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  from_namespace_id TEXT NOT NULL REFERENCES namespaces(id),
  to_namespace_id TEXT REFERENCES namespaces(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'transfer')),
  verification TEXT CHECK (verification IN ('linked_account', 'claim_file')),
  claim_token_hash TEXT,
  source_choice TEXT CHECK (source_choice IN ('upstream', 'wrapper')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'accepted', 'completed', 'declined')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE aliases (
  old_namespace TEXT NOT NULL,
  old_name TEXT NOT NULL,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (old_namespace, old_name)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'system', 'github', 'gitlab')),
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

-- Full-text search over tool metadata and README/guide text, kept in sync by triggers.
CREATE VIRTUAL TABLE tools_fts USING fts5 (
  namespace, name, summary, tags, body,
  content = '',
  contentless_delete = 1,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER tools_fts_insert AFTER INSERT ON tools BEGIN
  INSERT INTO tools_fts (rowid, namespace, name, summary, tags, body)
  VALUES (new.rowid, (SELECT name FROM namespaces WHERE id = new.namespace_id), new.name, new.summary, new.tags, new.readme_text);
END;

CREATE TRIGGER tools_fts_update AFTER UPDATE OF name, summary, tags, readme_text, namespace_id ON tools BEGIN
  DELETE FROM tools_fts WHERE rowid = old.rowid;
  INSERT INTO tools_fts (rowid, namespace, name, summary, tags, body)
  VALUES (new.rowid, (SELECT name FROM namespaces WHERE id = new.namespace_id), new.name, new.summary, new.tags, new.readme_text);
END;

CREATE TRIGGER tools_fts_delete AFTER DELETE ON tools BEGIN
  DELETE FROM tools_fts WHERE rowid = old.rowid;
END;
