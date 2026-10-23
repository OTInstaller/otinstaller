-- Images hosted on the mirror (mirror.otinstaller.com) as their primary home, pushed by publishers with their own
-- ot_ tokens (`ot publish --image`). Every manifest a publisher pushes is recorded, for the push limits and for the
-- nightly clean-up of images that never became a published version.
CREATE TABLE mirror_pushes (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  digest TEXT NOT NULL,
  tag TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  token_id TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX mirror_pushes_repo ON mirror_pushes (repo, digest);
CREATE INDEX mirror_pushes_created ON mirror_pushes (created_at);

-- An image backup row that is the image itself (it already lives on the mirror): takedowns, purges, legal holds and
-- drills treat it like any image backup, but it is not offered as an install fallback.
ALTER TABLE backups ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;
