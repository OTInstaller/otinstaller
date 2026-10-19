-- Release tags a repo-mode source already had when it was connected, before it had a package. Sync never
-- backfills them: they predate the author adding otinstaller.yaml and would only fail as publish jobs.
ALTER TABLE sources ADD COLUMN baseline_tags TEXT;
