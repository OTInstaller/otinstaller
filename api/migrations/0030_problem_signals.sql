-- Problems reported from a tool page's "Report a problem" without signing in: daily counts per version, kind and
-- platform, never who sent them. Broken counts join ot's failed-run counts (run_signals) toward the version's
-- unconfirmed issue; outdated counts, always about the latest version, open their own. Logic in src/community.ts
-- (reportProblem).

CREATE TABLE problem_signals (
  tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('broken', 'outdated')),
  -- linux/amd64 and the like, as the site guesses it from the browser; '' when unknown, and for outdated.
  platform TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, day, kind, platform)
);
