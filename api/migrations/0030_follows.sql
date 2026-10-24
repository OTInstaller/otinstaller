-- Following a publisher (every new version of its packages, and its new packages) or an input type (new tools and
-- guides that take it), beside following one package (0029). The same "releases" email preference covers all three.
-- Logic in src/inbox.ts (notifyFollowers) and src/routes/inbox.ts.

CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('publisher', 'input')),
  -- A namespace's name for a publisher, an input type for an input.
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, target)
);
CREATE INDEX follows_target ON follows (kind, target);
