-- Following a package's releases: people follow a package and get an inbox item (and an email, per their "releases"
-- preference) when a new version becomes its latest. Versions remember when they were announced, so a version is
-- announced once whatever republishes it. Logic in src/inbox.ts (notifyFollowers) and src/scans.ts (publishVersion).

CREATE TABLE package_follows (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tool_id, user_id)
);
CREATE INDEX package_follows_user ON package_follows (user_id, created_at DESC);

-- New versions of followed packages.
ALTER TABLE email_prefs ADD COLUMN releases TEXT NOT NULL DEFAULT 'immediate' CHECK (releases IN ('immediate', 'daily', 'off'));

-- When a version was announced (followers notified, open issues asked whether it fixes them); null until it becomes
-- the latest. Versions published before this are counted as announced.
ALTER TABLE versions ADD COLUMN announced_at INTEGER;
UPDATE versions SET announced_at = published_at WHERE published_at IS NOT NULL;

-- The inbox's scope also takes "releases", which needs the table rebuilt for its CHECK.
CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- issue_opened, comment, status, moderation, role, proposal, release
  kind TEXT NOT NULL,
  -- Which preference decides the email: community, owner_issues, releases, or account (always sent: moderation, roles).
  scope TEXT NOT NULL CHECK (scope IN ('community', 'owner_issues', 'releases', 'account')),
  tool_id TEXT,
  issue_id TEXT,
  actor_id TEXT,
  summary TEXT NOT NULL,
  -- Site path the item links to, such as /ns/name/issues/3.
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  -- Set once the item was emailed, or when the person's preference means it never will be.
  emailed_at INTEGER
);
INSERT INTO inbox_new (id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at, read_at, emailed_at)
  SELECT id, user_id, kind, scope, tool_id, issue_id, actor_id, summary, path, created_at, read_at, emailed_at FROM inbox;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
CREATE INDEX inbox_user ON inbox (user_id, created_at DESC);
CREATE INDEX inbox_pending ON inbox (created_at) WHERE emailed_at IS NULL;
