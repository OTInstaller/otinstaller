-- Week 11: source and artifact backups (git bundles, wheels, the image mirror) and monthly restore drills.

-- Owners can opt out of git backups; artifact mirroring stays on because installs depend on it.
ALTER TABLE tools ADD COLUMN git_backups INTEGER NOT NULL DEFAULT 1;
-- A legal hold keeps a removed package's backups past the usual deletion.
ALTER TABLE tools ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN legal_hold_reason TEXT;

-- One backup job: the uploads the scanner does after a passing scan, a weekly git backup, or one an admin started.
-- The token authorizes its single completion call.
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  version_id TEXT REFERENCES versions(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('release', 'weekly', 'manual')),
  token_hash TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'completed', 'expired', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX backup_runs_status ON backup_runs (status, expires_at);

-- What is backed up. location is the R2 key (git, wheel) or the mirror repository@digest (image).
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES backup_runs(id),
  tool_id TEXT NOT NULL REFERENCES tools(id),
  version_id TEXT REFERENCES versions(id),
  kind TEXT NOT NULL CHECK (kind IN ('git', 'wheel', 'image')),
  location TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  weekly INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'too_large', 'failed', 'deleted')),
  size_bytes INTEGER,
  sha256 TEXT,
  filename TEXT,
  refs_count INTEGER,
  detail TEXT,
  delete_after INTEGER,
  created_at INTEGER NOT NULL,
  stored_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX backups_tool ON backups (tool_id, kind, status, created_at DESC);
CREATE INDEX backups_version ON backups (version_id, kind, status);
CREATE INDEX backups_delete ON backups (delete_after);

-- Monthly restore drills: a random bundle restored into an empty repository and a mirrored image pulled by digest.
CREATE TABLE restore_drills (
  id TEXT PRIMARY KEY,
  git_backup_id TEXT REFERENCES backups(id),
  image_backup_id TEXT REFERENCES backups(id),
  token_hash TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'pass', 'fail', 'expired')),
  detail TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
