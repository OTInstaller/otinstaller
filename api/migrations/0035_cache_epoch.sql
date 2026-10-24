-- The edge cache can't be purged, so a takedown or a yank used to keep being served for as long as the cached answers
-- allowed (a day for wheel copies, an hour for exact-version manifests). Every edge-cache key now carries the current
-- cache epoch, and removals and yanks move it on, so all cached answers stop being served at once. Logic in
-- src/edge-cache.ts (cacheEpoch, bumpCacheEpoch).

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO settings (key, value, updated_at) VALUES ('cache_epoch', '0', 0);
