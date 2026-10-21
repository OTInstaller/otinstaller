-- Week 12 (closed beta): feedback from the site's form and `ot feedback`, triaged in the admin console.
-- Numbered after week 11's 0011_backups.sql, which is on its own branch; D1 applies whichever is missing.

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'question', 'other')),
  message TEXT NOT NULL,
  email TEXT,                -- where to reply when the sender isn't signed in (optional)
  page TEXT,                 -- the site path, or the `ot` command it is about
  source TEXT NOT NULL CHECK (source IN ('web', 'cli')),
  client TEXT,               -- e.g. "ot 0.9.0 (windows/amd64)"
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_queue ON feedback (status, created_at);
