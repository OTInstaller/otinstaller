-- Usage counts: how often each package is installed and run, as daily totals (docs/dev/database.md). `ot` sends
-- POST /installs after an install and POST /runs with a command's runs; nothing here holds an address, user or token.
-- Each address is counted once per package and day through a salted hash in rate_limits, purged after a day. The
-- nightly cron folds these into tools.installs_30d, runs_30d, installs_total and runs_total. Logic in src/usage.ts.

-- Runs per package version, day, kind of client and how the run ended. duration_ms sums the runs that started, for
-- the mean. version_id has no foreign key, so rebuilding versions never trips on it.
CREATE TABLE run_counts (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,                                        -- YYYY-MM-DD, UTC, when the registry received it
  client TEXT NOT NULL CHECK (client IN ('cli', 'ci', 'mcp', 'other')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'empty', 'error', 'timeout', 'interrupted', 'engine_error', 'no_engine', 'not_started', 'missing_key')),
  count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, day, version_id, client, outcome)
);
CREATE INDEX run_counts_day ON run_counts (day);

-- Addresses that ran a package on a day, each counted once.
CREATE TABLE run_runners (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  runners INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, day)
);
CREATE INDEX run_runners_day ON run_runners (day);

-- Installs that came from the registry's backups (from_backup) and installs that failed, by reason.
CREATE TABLE install_outcomes (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('from_backup', 'no_engine', 'pull_failed', 'verify_failed', 'build_failed', 'refused', 'interrupted', 'error')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, day, version_id, outcome)
);
CREATE INDEX install_outcomes_day ON install_outcomes (day);

-- Registry-wide daily counts, one dimension at a time, with values from fixed lists only: os, arch, engine, via,
-- mcp_client, ot_version, milestone (first_install, first_run, first_ok_run) and addresses (ran, installed).
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, value)
);

-- install_counts gains the kind of client per package (install_clients only had it registry-wide, and is no longer
-- written), loses its foreign key to versions and gets an index on day. Rows from before this migration are 'unknown'.
CREATE TABLE install_counts_new (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT 'unknown' CHECK (client IN ('cli', 'ci', 'mcp', 'other', 'unknown')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, day, version_id, client)
);
INSERT INTO install_counts_new (tool_id, version_id, day, client, count)
  SELECT tool_id, version_id, day, 'unknown', count FROM install_counts;
DROP TABLE install_counts;
ALTER TABLE install_counts_new RENAME TO install_counts;
CREATE INDEX install_counts_day ON install_counts (day);

-- Runs that started in the last 30 days, and all-time totals, kept up to date by the nightly refreshUsage.
ALTER TABLE tools ADD COLUMN runs_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN installs_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN runs_total INTEGER NOT NULL DEFAULT 0;
UPDATE tools SET installs_total = (SELECT COALESCE(SUM(count), 0) FROM install_counts WHERE tool_id = tools.id);
