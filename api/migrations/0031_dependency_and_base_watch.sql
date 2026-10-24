-- Keeping the registry's own builds current, beside the upstream watcher (0021): the first-party tools' pinned PyPI
-- dependencies (requirements.txt), and the base image each Docker build in the community namespace starts from.
-- A dependency behind its latest release gets an issue and a pull request updating requirements.txt, released like a
-- bump; a base image that changed since the build, under a version whose scan found fixable critical or high
-- vulnerabilities, gets a rebuild (REBUILD_WATCH=rebuild). Both are followed to the end in bump_prs, whose new `kind`
-- says which. Logic in src/build-watch.ts and src/bumps.ts.

CREATE TABLE dependency_watch (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  ecosystem TEXT NOT NULL DEFAULT 'pypi' CHECK (ecosystem IN ('pypi')),
  -- The name as requirements.txt writes it.
  package TEXT NOT NULL,
  pinned TEXT NOT NULL,
  latest TEXT,
  latest_at INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('current', 'behind', 'unknown', 'error')),
  error TEXT,
  -- The tool version requirements.txt was read from; it is only read again when that changes.
  pinned_version_id TEXT,
  checked_at INTEGER,
  changed_at INTEGER,
  PRIMARY KEY (tool_id, ecosystem, package)
);

-- The current digest of each base image tag the builds use, looked up at most once a night for all of them.
CREATE TABLE base_images (
  -- Docker Hub repository and tag, e.g. library/python:3.12-slim.
  image TEXT PRIMARY KEY,
  digest TEXT,
  error TEXT,
  checked_at INTEGER NOT NULL,
  changed_at INTEGER
);

CREATE TABLE base_watch (
  tool_id TEXT PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  -- The final stage's FROM, as the Dockerfile writes it.
  image TEXT,
  -- The base's digest when the watcher first saw the version (close to the one it was built on).
  built_digest TEXT,
  latest_digest TEXT,
  pinned_version_id TEXT,
  state TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('current', 'updated', 'unknown', 'error')),
  error TEXT,
  -- When the registry last started a rebuild of this package.
  rebuilt_at INTEGER,
  checked_at INTEGER,
  changed_at INTEGER
);

-- upstream: a community wrapper's pin; dependency: a first-party tool's requirements.txt; rebuild: the same source
-- built again on a newer base image (no pull request: pr_number is 0).
ALTER TABLE bump_prs ADD COLUMN kind TEXT NOT NULL DEFAULT 'upstream' CHECK (kind IN ('upstream', 'dependency', 'rebuild'));
