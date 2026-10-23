-- Trusted publishing: a GitHub Actions workflow or a GitLab CI pipeline publishes with `ot publish --oidc`, proving its
-- repository with the CI's OIDC ID token instead of through the GitHub App or a connected GitLab project. A
-- namespace's owners name the repositories they trust, optionally narrowed to one workflow, environment or package.
-- The repository's and its owner's ids are pinned the first time a run uses the publisher, so a repository that is
-- deleted and created again under the same name by someone else can't publish.
CREATE TABLE trusted_publishers (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repository TEXT NOT NULL,
  repository_id TEXT,
  owner_id TEXT,
  workflow TEXT,
  environment TEXT,
  package TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX trusted_publishers_repo ON trusted_publishers (provider, repository, namespace_id);
CREATE INDEX trusted_publishers_namespace ON trusted_publishers (namespace_id);

-- The ot_ token a CI run gets for its ID token (POST /v1/auth/oidc/token) acts as the publisher's creator but is
-- restricted to one namespace (and package, when set), and only uploads a release and follows its job. jti is the ID
-- token's own (prefixed with the provider), so the same ID token can't be exchanged twice.
ALTER TABLE api_tokens ADD COLUMN namespace_id TEXT REFERENCES namespaces(id) ON DELETE CASCADE;
ALTER TABLE api_tokens ADD COLUMN package TEXT;
ALTER TABLE api_tokens ADD COLUMN trusted_publisher_id TEXT REFERENCES trusted_publishers(id) ON DELETE SET NULL;
ALTER TABLE api_tokens ADD COLUMN oidc_json TEXT;
ALTER TABLE api_tokens ADD COLUMN jti TEXT;
CREATE UNIQUE INDEX api_tokens_jti ON api_tokens (jti);

-- Which trusted publisher an upload from CI came through, and the run that sent it (workflow, ref, run, actor), which
-- the job page shows.
ALTER TABLE publish_jobs ADD COLUMN trusted_publisher_id TEXT REFERENCES trusted_publishers(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs ADD COLUMN ci_json TEXT;
