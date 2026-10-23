-- Tool requests: anyone signed in asks for an open-source tool to be packaged, others add their vote, and triagers
-- move each request from open to accepted, in progress, published or declined. One request per repository.
-- Rules live in src/requests.ts.

CREATE TABLE tool_requests (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repo_path TEXT NOT NULL,
  -- lower(provider:path), so the same repository is only requested once.
  repo_key TEXT NOT NULL UNIQUE,
  project_id TEXT,
  url TEXT NOT NULL,
  description TEXT,
  license TEXT,
  upstream_stars INTEGER,
  pushed_at INTEGER,
  -- The requester's note: plain text, never rendered as Markdown or links.
  note TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'in_progress', 'published', 'declined')),
  decline_code TEXT CHECK (decline_code IS NULL OR decline_code IN
    ('license', 'archived', 'not_osint', 'not_cli', 'needs_login', 'acceptable_use', 'unmaintained', 'duplicate', 'withdrawn', 'other')),
  decision_note TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at INTEGER,
  -- The package that answers the request, once one is published.
  tool_id TEXT REFERENCES tools(id) ON DELETE SET NULL,
  -- What the registry already knew when it was requested (src/known-repos.ts).
  otlite_name TEXT,
  dropped_reason TEXT,
  vote_count INTEGER NOT NULL DEFAULT 0,
  moderation TEXT NOT NULL DEFAULT 'visible' CHECK (moderation IN ('visible', 'held', 'hidden')),
  hidden_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tool_requests_board ON tool_requests (status, vote_count DESC, number DESC);
CREATE INDEX tool_requests_project ON tool_requests (provider, project_id);
CREATE INDEX tool_requests_requester ON tool_requests (requested_by, created_at);

CREATE TABLE request_votes (
  request_id TEXT NOT NULL REFERENCES tool_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

CREATE INDEX request_votes_user ON request_votes (user_id, created_at);
