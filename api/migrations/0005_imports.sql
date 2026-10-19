-- Week 7: the import wizard. The placeholder imports table from 0001 was never written to; it is rebuilt
-- so a draft can exist before its project ID is known (bulk imports detect in the background), with the
-- detection results and how the import was finished.
DROP TABLE imports;

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  batch_id TEXT,
  community INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  project_id TEXT,
  path TEXT NOT NULL,
  url TEXT,
  namespace TEXT,
  detected_kind TEXT CHECK (detected_kind IN ('docker', 'pipx', 'guide')),
  detection_json TEXT,
  draft_manifest_json TEXT,
  finish_mode TEXT CHECK (finish_mode IN ('pr', 'registry', 'connect', 'wrapper')),
  wrapper_path TEXT,
  pr_url TEXT,
  source_id TEXT REFERENCES sources(id),
  status TEXT NOT NULL DEFAULT 'detecting' CHECK (status IN ('detecting', 'draft', 'ready', 'finished', 'failed')),
  error_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX imports_user ON imports (user_id, created_at DESC);
CREATE INDEX imports_batch ON imports (batch_id);
