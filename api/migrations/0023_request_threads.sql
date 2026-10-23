-- Discussion on tool requests: replies under each request, the people following it, and locks, moderated like issue
-- comments. Flags can now name a request or a reply on one. Logic in src/requests.ts and src/community.ts; the issue
-- tables are in 0016 and the requests in 0018.

CREATE TABLE request_comments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES tool_requests(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'system')),
  -- triager or staff, as it was when the reply was written (a request belongs to no package, so it has no maintainers).
  role_badge TEXT,
  body_md TEXT NOT NULL,
  moderation TEXT NOT NULL DEFAULT 'visible' CHECK (moderation IN ('visible', 'held', 'hidden')),
  hidden_reason TEXT,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX request_comments_request ON request_comments (request_id, created_at);
CREATE INDEX request_comments_held ON request_comments (moderation, created_at) WHERE moderation != 'visible';
CREATE INDEX request_comments_author ON request_comments (author_id);

CREATE TABLE request_subscriptions (
  request_id TEXT NOT NULL REFERENCES tool_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- author, commented or manual: why the person follows the request.
  reason TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

-- Visible replies, kept by requests.ts; and when a triager (or the nightly cron, 30 days after a decision) closed the
-- thread to replies.
ALTER TABLE tool_requests ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_requests ADD COLUMN locked_at INTEGER;

-- People who asked for a tool follow their request.
INSERT INTO request_subscriptions (request_id, user_id, reason, created_at)
  SELECT id, requested_by, 'author', created_at FROM tool_requests WHERE requested_by IS NOT NULL;

-- Flags on requests and their replies: rebuild content_flags to widen target_kind's CHECK.
CREATE TABLE content_flags_new (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue', 'comment', 'request', 'request_comment')),
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
INSERT INTO content_flags_new (id, target_kind, target_id, flagger_id, reason, note, status, resolved_by, resolved_at, created_at)
  SELECT id, target_kind, target_id, flagger_id, reason, note, status, resolved_by, resolved_at, created_at FROM content_flags;
DROP TABLE content_flags;
ALTER TABLE content_flags_new RENAME TO content_flags;
CREATE INDEX content_flags_open ON content_flags (status, created_at);
