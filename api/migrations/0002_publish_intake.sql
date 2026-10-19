-- Week 4: GitHub App installations, publish job tracking and sign-in.

ALTER TABLE installations ADD COLUMN account_login TEXT;
ALTER TABLE installations ADD COLUMN account_type TEXT;
ALTER TABLE installations ADD COLUMN repository_selection TEXT NOT NULL DEFAULT 'selected';
ALTER TABLE installations ADD COLUMN created_at INTEGER;

ALTER TABLE publish_jobs ADD COLUMN installation_id INTEGER;
ALTER TABLE publish_jobs ADD COLUMN repo_id TEXT;
ALTER TABLE publish_jobs ADD COLUMN commit_sha TEXT;
ALTER TABLE publish_jobs ADD COLUMN tool_id TEXT REFERENCES tools(id);
ALTER TABLE publish_jobs ADD COLUMN problems_json TEXT;
ALTER TABLE publish_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publish_jobs ADD COLUMN updated_at INTEGER;

CREATE INDEX publish_jobs_tool ON publish_jobs (tool_id, created_at DESC);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX api_tokens_user ON api_tokens (user_id);
