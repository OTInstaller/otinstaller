-- Notifications for people who take part: an inbox on the site, and email sent at once or as a daily digest, with
-- one-click unsubscribe. Logic in src/inbox.ts; publisher and staff emails stay in notify.ts as they were.

CREATE TABLE email_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Threads the person follows (their issues, ones they replied to or confirmed, ones they follow).
  community TEXT NOT NULL DEFAULT 'immediate' CHECK (community IN ('immediate', 'daily', 'off')),
  -- New broken, outdated and wrong-information issues on packages of namespaces they belong to.
  owner_issues TEXT NOT NULL DEFAULT 'immediate' CHECK (owner_issues IN ('immediate', 'daily', 'off')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- issue_opened, comment, status, moderation, role
  kind TEXT NOT NULL,
  -- Which preference decides the email: community, owner_issues, or account (always sent: moderation, roles).
  scope TEXT NOT NULL CHECK (scope IN ('community', 'owner_issues', 'account')),
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
CREATE INDEX inbox_user ON inbox (user_id, created_at DESC);
CREATE INDEX inbox_pending ON inbox (created_at) WHERE emailed_at IS NULL;
