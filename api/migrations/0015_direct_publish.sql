-- Direct publishing: releases uploaded as a bundle with `ot publish` instead of read from a tagged commit, and
-- namespaces a signed-in user creates on the registry (provider 'registry', which 0001 already allows).
-- A bundle job names its namespace itself (tag jobs find it through the installation or the source), keeps its
-- files in R2 CONTENT under bundle_key while it is validated, and records who uploaded it.
ALTER TABLE publish_jobs ADD COLUMN namespace_id TEXT REFERENCES namespaces(id);
ALTER TABLE publish_jobs ADD COLUMN bundle_key TEXT;
ALTER TABLE publish_jobs ADD COLUMN submitted_by TEXT REFERENCES users(id);
CREATE INDEX publish_jobs_namespace ON publish_jobs (namespace_id, created_at);

-- Who created a registry namespace: for the per-user limit and the review queue.
ALTER TABLE namespaces ADD COLUMN created_by TEXT REFERENCES users(id);
