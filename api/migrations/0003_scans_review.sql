-- Week 5: scan dispatch and callbacks, verdicts, review queue, notifications.

ALTER TABLE versions ADD COLUMN scan_token_hash TEXT;
ALTER TABLE versions ADD COLUMN scan_token_expires_at INTEGER;
ALTER TABLE versions ADD COLUMN scan_dispatched_at INTEGER;
ALTER TABLE versions ADD COLUMN expected_signer_regexp TEXT;
ALTER TABLE versions ADD COLUMN expected_signer_issuer TEXT;
ALTER TABLE versions ADD COLUMN rejected_reason TEXT;

CREATE UNIQUE INDEX versions_scan_token ON versions (scan_token_hash) WHERE scan_token_hash IS NOT NULL;
CREATE INDEX versions_status ON versions (status, scan_dispatched_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL
);
