-- Week 8: guides and tool docs. Rendered pages live in R2 (the CONTENT bucket); D1 keeps their navigation,
-- table of contents and every link found in them, so link checks can run at publish time and nightly.

ALTER TABLE pages ADD COLUMN toc_json TEXT;
-- Plain text for search: a tool's README, or a guide's pages (first 20 KB each). Copied to tools.readme_text,
-- which feeds tools_fts, when the version becomes the latest.
ALTER TABLE versions ADD COLUMN search_text TEXT;

CREATE TABLE page_links (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  url TEXT NOT NULL,
  line INTEGER,
  -- missing: a link to a page that is not in the guide; skipped: an example domain that is never fetched;
  -- unchecked: over the per-version limit.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ok', 'dead', 'missing', 'skipped', 'unchecked', 'malicious')),
  http_status INTEGER,
  -- Cloudflare URL Scanner: the scan's ID, then its verdict (clean, malicious or unknown).
  scan_id TEXT,
  scan_verdict TEXT,
  checked_at INTEGER
);
CREATE INDEX page_links_version ON page_links (version_id, url);

-- A guide whose latest version has more than 20% dead links is marked "Needs update".
ALTER TABLE tools ADD COLUMN needs_update INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN dead_link_ratio REAL;

CREATE INDEX tool_guides_tool ON tool_guides (tool_id);
