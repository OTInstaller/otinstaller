-- Community wrapper submissions: anyone signed in can package someone else's open-source tool. The registry's
-- community bot creates the wrapper repository in osintverse-community and starts its release; the first release
-- waits for a staff or community reviewer (tools.needs_first_review), whatever the namespace's own status. The
-- submitter becomes a maintainer of the package. Rules live in src/submissions.ts.

ALTER TABLE tools ADD COLUMN needs_first_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
-- The project a community wrapper packages, for the upstream watcher and "Packaged by" on the tool page.
ALTER TABLE tools ADD COLUMN upstream_url TEXT;

UPDATE tools SET upstream_url = (SELECT json_extract(v.manifest_json, '$.homepage') FROM versions v WHERE v.id = tools.latest_version_id)
WHERE community_packaged = 1 AND upstream_url IS NULL;

-- People who look after a community package besides the namespace's owners: the submitter, and others staff add.
CREATE TABLE tool_maintainers (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('submitter', 'added')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tool_id, user_id)
);

CREATE INDEX tool_maintainers_user ON tool_maintainers (user_id);

CREATE TABLE wrapper_submissions (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  import_id TEXT REFERENCES imports(id) ON DELETE SET NULL,
  request_id TEXT REFERENCES tool_requests(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  upstream_path TEXT NOT NULL,
  -- lower(provider:path); one open submission per upstream.
  upstream_key TEXT NOT NULL,
  upstream_url TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('docker', 'pipx')),
  -- Whether the release builds an image from the Dockerfile (else it pins upstream's own image or wheel).
  builds INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL,
  dockerfile TEXT,
  -- {flags: [{code, message}], dockerfile: [{code, message}]}: what reviewers should look at.
  checks_json TEXT NOT NULL DEFAULT '{}',
  template_conformant INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN
    ('submitted', 'releasing', 'in_review', 'changes_requested', 'published', 'rejected', 'withdrawn', 'failed')),
  wrapper_repo TEXT,
  wrapper_repo_id TEXT,
  released_version TEXT,
  tool_id TEXT REFERENCES tools(id) ON DELETE SET NULL,
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX wrapper_submissions_status ON wrapper_submissions (status, updated_at DESC);
CREATE INDEX wrapper_submissions_upstream ON wrapper_submissions (upstream_key);
CREATE INDEX wrapper_submissions_repo ON wrapper_submissions (wrapper_repo_id);
CREATE INDEX wrapper_submissions_user ON wrapper_submissions (user_id, created_at);
