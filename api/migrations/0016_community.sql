-- Community: issues and discussion on every package, "works for me" confirmations, flags, moderation and the
-- triager and reviewer roles staff grant to trusted members. Logic in src/community.ts, routes in
-- src/routes/community.ts. Requests (0018) and notifications (0017) build on these tables.

-- A public name for each person, unique across sign-in providers (logins alone can repeat between GitHub, GitLab and
-- OSINTverse). New users get one at sign-in.
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN profile_hidden INTEGER NOT NULL DEFAULT 0;
-- Set by a moderator's timeout (at most 7 days); bans stay users.banned_at.
ALTER TABLE users ADD COLUMN posting_blocked_until INTEGER;
UPDATE users SET handle = lower(login) WHERE id IN (SELECT MIN(id) FROM users GROUP BY lower(login));
UPDATE users SET handle = lower(login) || '-' || lower(substr(id, -4)) WHERE handle IS NULL;
CREATE UNIQUE INDEX users_handle ON users (handle);

CREATE TABLE community_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- triager: triage any package's issues and moderate posts; reviewer: also approve community submissions.
  role TEXT NOT NULL CHECK (role IN ('triager', 'reviewer')),
  granted_by TEXT,
  note TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  -- Numbered per package from 1, as people refer to them (#12).
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('broken', 'outdated', 'wrong_info', 'feature', 'question')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'fixed', 'wont_fix', 'duplicate')),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  -- What the reporter ran: structured, so nobody has to paste a command line with their target in it.
  version TEXT,
  platform TEXT,
  engine TEXT CHECK (engine IN ('docker', 'podman', 'native')),
  exit_code INTEGER,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- system: opened by the registry itself (the upstream watcher, health checks, many failed runs).
  author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'system')),
  system_source TEXT,
  dedupe_key TEXT,
  duplicate_of INTEGER,
  fixed_in TEXT,
  moderation TEXT NOT NULL DEFAULT 'visible' CHECK (moderation IN ('visible', 'held', 'hidden')),
  hidden_reason TEXT,
  locked_at INTEGER,
  deleted_at INTEGER,
  edited_at INTEGER,
  -- When someone who can triage the package first replied; an issue page is indexable from then on.
  maintainer_replied_at INTEGER,
  comment_count INTEGER NOT NULL DEFAULT 0,
  me_too_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT,
  UNIQUE (tool_id, number)
);
CREATE UNIQUE INDEX issues_dedupe ON issues (tool_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX issues_tool ON issues (tool_id, status, last_activity_at DESC);
CREATE INDEX issues_board ON issues (status, kind, last_activity_at DESC) WHERE moderation = 'visible' AND deleted_at IS NULL;
CREATE INDEX issues_held ON issues (moderation, created_at) WHERE moderation != 'visible';

CREATE TABLE issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'system')),
  -- maintainer (a member of the package's namespace), triager or staff, as it was when the comment was written.
  role_badge TEXT,
  body_md TEXT NOT NULL,
  moderation TEXT NOT NULL DEFAULT 'visible' CHECK (moderation IN ('visible', 'held', 'hidden')),
  hidden_reason TEXT,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX issue_comments_issue ON issue_comments (issue_id, created_at);
CREATE INDEX issue_comments_held ON issue_comments (moderation, created_at) WHERE moderation != 'visible';

-- "Works for me" and "broken for me": one per person, version and platform. Counts are shown, never a score.
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('works', 'broken')),
  platform TEXT NOT NULL DEFAULT '',
  engine TEXT,
  ot_version TEXT,
  issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (version_id, user_id, platform)
);
CREATE INDEX confirmations_tool ON confirmations (tool_id, created_at);

-- Failed runs reported without signing in (ot's prompt): daily counts only, never who or what was run.
CREATE TABLE run_signals (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  exit_class TEXT NOT NULL CHECK (exit_class IN ('exit', 'timeout')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, day, platform, engine, exit_class)
);

CREATE TABLE content_flags (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue', 'comment')),
  target_id TEXT NOT NULL,
  flagger_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('personal_data', 'spam', 'abuse', 'off_topic', 'other')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'dismissed')),
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (target_kind, target_id, flagger_id)
);
CREATE INDEX content_flags_open ON content_flags (status, created_at);

CREATE TABLE issue_subscriptions (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- author, commented, confirmed or manual: why the person follows the thread.
  reason TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);

-- What kind of failure a health check was (exit_code, timeout, no_output, pull_failed), for the public history; the
-- error excerpt itself stays private.
ALTER TABLE health_checks ADD COLUMN failure_class TEXT;

-- Open broken and outdated issues per package, kept by community.ts, for badges and the status line.
ALTER TABLE tools ADD COLUMN open_broken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN open_outdated INTEGER NOT NULL DEFAULT 0;
