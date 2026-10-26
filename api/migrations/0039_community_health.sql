-- A package's status now comes from what people report, not from a nightly run of every tool: Possibly broken while
-- it has an open broken issue, or while two or more people said its latest version is broken in the last 30 days and
-- outnumber those who said it works; healthy once someone said the latest version works; unknown until then.
-- health_checked_at is when someone last said the latest version works. refreshCounts (src/community.ts) keeps it
-- current and refreshAllHealth recomputes it nightly; this sets it once from the reports already made, which also
-- clears the old nightly results and 'not_checked'.

DROP TABLE health_checks;
ALTER TABLE tools DROP COLUMN health_fail_streak;

UPDATE tools SET
  health_status = CASE
    WHEN EXISTS (SELECT 1 FROM issues WHERE tool_id = tools.id AND kind = 'broken' AND status IN ('open', 'confirmed') AND moderation = 'visible' AND deleted_at IS NULL)
      OR ((SELECT COUNT(*) FROM confirmations WHERE version_id = tools.latest_version_id AND result = 'broken' AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000) >= 2
        AND (SELECT COUNT(*) FROM confirmations WHERE version_id = tools.latest_version_id AND result = 'broken' AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000)
          > (SELECT COUNT(*) FROM confirmations WHERE version_id = tools.latest_version_id AND result = 'works' AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000))
      THEN 'broken'
    WHEN EXISTS (SELECT 1 FROM confirmations WHERE version_id = tools.latest_version_id AND result = 'works' AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000)
      THEN 'healthy'
    ELSE 'unknown' END,
  health_checked_at = (SELECT MAX(created_at) FROM confirmations WHERE version_id = tools.latest_version_id AND result = 'works'
    AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000);
