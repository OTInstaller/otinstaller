-- Week 10: takedowns and transparency, deprecation, health checks, claims and transfers.

-- Removals: when, by whom, and a public reason category for the transparency page.
ALTER TABLE versions ADD COLUMN removed_at INTEGER;
ALTER TABLE versions ADD COLUMN removed_by TEXT REFERENCES users(id);
ALTER TABLE versions ADD COLUMN removed_category TEXT;
ALTER TABLE tools ADD COLUMN removed_at INTEGER;
ALTER TABLE tools ADD COLUMN removed_reason TEXT;
ALTER TABLE tools ADD COLUMN removed_category TEXT;

-- Deprecation points at a replacement package.
ALTER TABLE tools ADD COLUMN deprecated_replacement TEXT;

-- Nightly health checks: a tool is "Possibly broken" after 3 failures in a row and healthy again after 1 pass.
ALTER TABLE tools ADD COLUMN health_fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN health_checked_at INTEGER;
CREATE INDEX health_checks_tool ON health_checks (tool_id, ran_at DESC);

-- Reports: the version reported, the reviewer's action, and when it was resolved.
ALTER TABLE reports ADD COLUMN action TEXT;
ALTER TABLE reports ADD COLUMN resolved_at INTEGER;

-- Claims and transfers: what the claimer must do, the upstream repository checked, and decisions.
ALTER TABLE transfers ADD COLUMN upstream_url TEXT;
ALTER TABLE transfers ADD COLUMN verification_error TEXT;
ALTER TABLE transfers ADD COLUMN accepted_by TEXT REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN completed_by TEXT REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN updated_at INTEGER;
CREATE INDEX transfers_tool ON transfers (tool_id, status);
CREATE INDEX transfers_status ON transfers (status, created_at);

CREATE INDEX audit_log_created ON audit_log (created_at DESC);

-- Fixed-window rate limits (anonymous reports: 5 per hour per IP). The key is a salted hash, never the IP
-- itself, and windows older than a day are deleted by the nightly cron.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
