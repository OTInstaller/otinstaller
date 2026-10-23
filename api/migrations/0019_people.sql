-- Contributor profiles (/people/<handle>): what each person did in the community, recomputed nightly by
-- people.ts:refreshContributorStats, and the indexes a profile's counts and recent posts need. A person can hide
-- their profile (users.profile_hidden, from 0016).

CREATE TABLE contributor_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  issues_opened INTEGER NOT NULL DEFAULT 0,
  -- Their broken, outdated and wrong-information issues that someone confirmed or that were fixed.
  issues_confirmed INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  confirmations INTEGER NOT NULL DEFAULT 0,
  requests_made INTEGER NOT NULL DEFAULT 0,
  requests_published INTEGER NOT NULL DEFAULT 0,
  -- Other people's issues they closed (as a maintainer, triager or staff).
  issues_triaged INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX issues_author ON issues (author_id, created_at DESC);
CREATE INDEX issue_comments_author ON issue_comments (author_id, created_at DESC);
CREATE INDEX confirmations_user ON confirmations (user_id);
CREATE INDEX issues_closed_by ON issues (closed_by);
