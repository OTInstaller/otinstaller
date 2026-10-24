-- Bump pull requests report what became of their release: merged (the release started), released (the version was
-- published) or failed (the build, validation or scan didn't publish it, and the maintainers were told). A failed
-- bump can be released again. With UPSTREAM_WATCH=auto the registry merges and releases pin-only bumps itself, unless
-- the package's maintainers turned that off (tools.auto_release). Rules live in src/bumps.ts.

CREATE TABLE bump_prs_new (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  -- Upstream's release the pull request bumps to.
  version TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'released', 'failed', 'closed')),
  -- The package version the latest attempt releases.
  released_version TEXT,
  merged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- 1 when the registry released it on its own (UPSTREAM_WATCH=auto).
  auto INTEGER NOT NULL DEFAULT 0,
  merge_sha TEXT,
  -- When the latest attempt started.
  merged_at INTEGER,
  -- The release workflow run that failed, when that is what happened.
  run_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tool_id, version)
);

INSERT INTO bump_prs_new (tool_id, version, pr_number, url, branch, status, released_version, merged_by, merged_at, attempts, released_at, created_at, updated_at)
SELECT b.tool_id, b.version, b.pr_number, b.url, b.branch,
  CASE WHEN b.status = 'merged' AND EXISTS (SELECT 1 FROM versions v WHERE v.tool_id = b.tool_id AND v.version = b.released_version AND v.status IN ('published', 'yanked'))
    THEN 'released' ELSE b.status END,
  b.released_version, b.merged_by,
  CASE WHEN b.status = 'merged' THEN b.updated_at END,
  CASE WHEN b.status = 'merged' THEN 1 ELSE 0 END,
  CASE WHEN b.status = 'merged' THEN (SELECT v.published_at FROM versions v WHERE v.tool_id = b.tool_id AND v.version = b.released_version AND v.status IN ('published', 'yanked')) END,
  b.created_at, b.updated_at
FROM bump_prs b;

DROP TABLE bump_prs;
ALTER TABLE bump_prs_new RENAME TO bump_prs;

CREATE INDEX bump_prs_open ON bump_prs (tool_id, status);
CREATE INDEX bump_prs_inflight ON bump_prs (status, merged_at);

-- Whether the registry may merge and release this package's pin-only bumps itself (UPSTREAM_WATCH=auto).
ALTER TABLE tools ADD COLUMN auto_release INTEGER NOT NULL DEFAULT 1;
