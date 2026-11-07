-- Failure alerts (src/usage.ts usageAlerts): a package's latest version whose runs have started failing much more than
-- its earlier versions'. The nightly cron writes a row when it tells the package's maintainers, so a version is told
-- about at most once every 14 days; staff read the rows in the daily digest and on the admin Usage tab. Nothing public.
CREATE TABLE usage_alerts (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,                                 -- no foreign key, as in run_counts
  failure_rate REAL NOT NULL,                               -- tool errors and timeouts over finished runs, last 7 days
  baseline_rate REAL,                                       -- the same for the package's other versions over 30 days; NULL with too few runs
  runs INTEGER NOT NULL,                                    -- finished runs in those 7 days
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (tool_id, version_id)
);
CREATE INDEX usage_alerts_sent ON usage_alerts (sent_at);
