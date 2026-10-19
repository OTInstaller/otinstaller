-- Week 6: GitLab projects, sync with source repositories, changelogs.
-- A source can now exist before its first release (a connected GitLab project has no tool yet),
-- so sources is rebuilt with a nullable tool_id and the fields sync needs.
PRAGMA defer_foreign_keys = true;

CREATE TABLE sources_v2 (
  id TEXT PRIMARY KEY,
  tool_id TEXT UNIQUE REFERENCES tools(id),
  namespace_id TEXT REFERENCES namespaces(id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  project_id TEXT NOT NULL,
  path TEXT,
  url TEXT NOT NULL,
  default_branch TEXT,
  manifest_mode TEXT NOT NULL DEFAULT 'repo' CHECK (manifest_mode IN ('repo', 'registry')),
  registry_manifest_json TEXT,
  connected_by TEXT REFERENCES users(id),
  installation_id INTEGER,
  webhook_id TEXT,
  webhook_secret_hash TEXT,
  description TEXT,
  topics TEXT,
  stars INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  visibility TEXT,
  etag TEXT,
  last_event_at INTEGER,
  last_poll_at INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'ok' CHECK (sync_status IN ('ok', 'paused', 'error', 'unavailable', 'transfer_pending')),
  last_error TEXT,
  unavailable_since INTEGER,
  created_at INTEGER,
  UNIQUE (provider, project_id)
);

INSERT INTO sources_v2 (id, tool_id, provider, project_id, url, default_branch, manifest_mode, registry_manifest_json,
  webhook_id, webhook_secret_hash, etag, last_event_at, last_poll_at, sync_status, last_error, namespace_id)
SELECT s.id, s.tool_id, s.provider, s.project_id, s.url, s.default_branch, s.manifest_mode, s.registry_manifest_json,
  s.webhook_id, s.webhook_secret_hash, s.etag, s.last_event_at, s.last_poll_at, s.sync_status, s.last_error,
  (SELECT t.namespace_id FROM tools t WHERE t.id = s.tool_id)
FROM sources s;

DROP TABLE sources;
ALTER TABLE sources_v2 RENAME TO sources;
CREATE INDEX sources_poll ON sources (sync_status, last_poll_at);
CREATE INDEX sources_namespace ON sources (namespace_id);

ALTER TABLE publish_jobs ADD COLUMN source_id TEXT REFERENCES sources(id);
ALTER TABLE versions ADD COLUMN changelog TEXT;
