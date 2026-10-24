-- People's own profiles (a display name, bio, location, website and links they choose, and a handle they can change
-- once every 30 days, old handles redirecting), a level on each package someone follows, followers hearing about
-- lifecycle changes and security warnings, and notification settings: an inbox switch per kind and the address emails
-- go to. Logic in src/people.ts, src/inbox.ts and src/routes/inbox.ts.

-- What a person writes on their profile. users.name (the sign-in provider's name) is never shown.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN location TEXT;
ALTER TABLE users ADD COLUMN website TEXT;
ALTER TABLE users ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
-- When the person last changed their handle; null if they never did.
ALTER TABLE users ADD COLUMN handle_changed_at INTEGER;

-- Handles people had before: each stays reserved for its owner and redirects to their profile.
CREATE TABLE handle_aliases (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX handle_aliases_user ON handle_aliases (user_id);

-- How much of a followed package reaches the person: all (new versions, lifecycle changes, security warnings),
-- releases (new versions and security warnings) or muted (nothing, even through a followed publisher or input type).
ALTER TABLE package_follows ADD COLUMN level TEXT NOT NULL DEFAULT 'all' CHECK (level IN ('all', 'releases', 'muted'));

-- Lifecycle changes (yanked, deprecated, taken down, moved) and security warnings on followed packages. People who
-- turned release emails off keep them off for these too.
ALTER TABLE email_prefs ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'immediate' CHECK (lifecycle IN ('immediate', 'daily', 'off'));
ALTER TABLE email_prefs ADD COLUMN security TEXT NOT NULL DEFAULT 'immediate' CHECK (security IN ('immediate', 'daily', 'off'));
UPDATE email_prefs SET lifecycle = releases, security = releases;
-- Scopes whose items stay out of the inbox list (they are still written, and emailed as the preference says).
ALTER TABLE email_prefs ADD COLUMN inbox_muted_json TEXT NOT NULL DEFAULT '[]';
-- The sign-in account whose email address gets the emails (github, gitlab, osintverse); null: the first one known.
ALTER TABLE email_prefs ADD COLUMN email_provider TEXT;

-- The inbox's scope also takes "lifecycle" and "security", which needs the table rebuilt for its CHECK.
CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- issue_opened, comment, status, moderation, role, proposal, release, lifecycle, security
  kind TEXT NOT NULL,
  -- Which preference decides the email: community, owner_issues, releases, lifecycle, security, or account (always
  -- sent: moderation, roles).
  scope TEXT NOT NULL CHECK (scope IN ('community', 'owner_issues', 'releases', 'lifecycle', 'security', 'account')),
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
