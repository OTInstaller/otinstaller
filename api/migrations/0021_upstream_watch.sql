-- The upstream watcher: for each community wrapper, which upstream release its latest version pins and what upstream
-- has released since. Checked nightly (upstream.ts). UPSTREAM_WATCH decides what it does with a difference: report
-- it (the default), or also open and close "outdated" issues.

CREATE TABLE upstream_watch (
  tool_id TEXT PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  provider TEXT CHECK (provider IS NULL OR provider IN ('github', 'gitlab')),
  upstream_path TEXT,
  -- How the pin was read (upstream-pin.ts kinds, or pipx, image, override, none).
  pin_kind TEXT,
  pinned TEXT,
  -- The PyPI project (or crate) a pip or cargo pin names, where upstream's latest version is looked up.
  pin_package TEXT,
  -- The tool version the pin was read from; the Dockerfile is only read again when it changes.
  pinned_version_id TEXT,
  latest TEXT,
  latest_at INTEGER,
  -- For commit pins: commits upstream's default branch is ahead.
  commits_behind INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('current', 'behind', 'unknown', 'archived', 'gone', 'license_changed', 'renamed', 'error')),
  upstream_license TEXT,
  releases_etag TEXT,
  -- A staff override when the pin can't be read: {"pin_kind": "...", "pinned": "..."}.
  override_json TEXT,
  error TEXT,
  checked_at INTEGER,
  changed_at INTEGER
);

CREATE INDEX upstream_watch_state ON upstream_watch (state, checked_at);
