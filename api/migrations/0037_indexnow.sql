-- IndexNow (https://www.indexnow.org): site pages a release, yank, deprecation, takedown or move changed are queued
-- here and sent to the search engines in one request by the 15-minute cron, instead of waiting for a crawl of the
-- sitemap. One row per path, so a page changed twice before the next run is sent once. Logic in src/indexnow.ts.

CREATE TABLE indexnow_queue (
  path TEXT PRIMARY KEY,       -- a path on SITE_URL, e.g. /osintverse-community/sherlock
  queued_at INTEGER NOT NULL   -- the latest change; a row re-queued while a submission is in flight is kept for the next
);

CREATE INDEX idx_indexnow_queue_queued ON indexnow_queue (queued_at);
