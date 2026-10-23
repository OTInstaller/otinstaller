-- Change proposals: a maintainer of a community wrapper changes more than its pin (the manifest, the Dockerfile, the
-- README) through the registry, since the wrapper repository belongs to osintverse-community. The community bot opens
-- a pull request with the files, and a staff or community reviewer who isn't the proposer approves it: the bot merges
-- it and starts the release. Pin-only bumps stay in bump_prs (0022). Rules live in src/proposals.ts.

CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  -- The pull request in the wrapper repository; a proposal is known by its number, as on GitHub.
  pr_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  proposer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  -- Why: the proposer's plain text, never rendered as Markdown or links.
  note TEXT,
  -- {path: content} for what the pull request writes: otinstaller.yaml, Dockerfile and README.md only.
  files_json TEXT NOT NULL,
  -- The version the release will have.
  version TEXT NOT NULL,
  -- Whether the wrapper builds its image from the Dockerfile (its release workflow), else a tag releases it.
  builds INTEGER NOT NULL DEFAULT 0,
  -- [{code, message}]: what the reviewer should look at (fields changed, Dockerfile rules missed, personal data).
  checks_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'changes_requested', 'merged', 'rejected', 'withdrawn')),
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  decided_at INTEGER,
  -- The package version the merge released.
  released_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tool_id, pr_number)
);

CREATE INDEX change_proposals_status ON change_proposals (status, updated_at DESC);
CREATE INDEX change_proposals_tool ON change_proposals (tool_id, created_at DESC);
CREATE INDEX change_proposals_proposer ON change_proposals (proposer_id, status);
