-- Shared results (`ot share`, `otlite share`): saved runs uploaded for a link that works for 24 hours. The runs
-- themselves are in R2 CONTENT at shares/<id>.json; this row says when the link stops working and who may delete it.
-- The 15-minute cron deletes expired rows and their objects. Logic in src/shares.ts.

CREATE TABLE shares (
  id TEXT PRIMARY KEY,                                      -- random, unguessable: the link is the only access control
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,     -- the signed-in sharer, never shown to viewers; NULL when anonymous
  delete_hash TEXT NOT NULL,                                -- sha256 of the delete token handed to the sharer
  source TEXT NOT NULL CHECK (source IN ('ot', 'otlite')),
  run_count INTEGER NOT NULL,
  tools_json TEXT NOT NULL,                                 -- the tools that ran, in order, for listings
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_shares_expires ON shares (expires_at);
CREATE INDEX idx_shares_owner ON shares (owner_id, expires_at);
