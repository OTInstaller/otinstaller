-- Bump pull requests: with UPSTREAM_WATCH=prs, the community bot opens a pull request in a community wrapper's
-- repository that changes only its pin to upstream's new release. The package's maintainers merge and release it.
-- Rules live in src/bumps.ts.

CREATE TABLE bump_prs (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  -- Upstream's release the pull request bumps to.
  version TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  -- The package version the merge released.
  released_version TEXT,
  merged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tool_id, version)
);

CREATE INDEX bump_prs_open ON bump_prs (tool_id, status);
