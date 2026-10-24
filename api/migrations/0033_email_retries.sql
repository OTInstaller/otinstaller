-- Emails that fail to send are retried. A notification row is now written as failed ("not sent yet") before Resend is
-- called and only becomes sent when Resend accepts it, so an email lost to a thrown fetch is no longer recorded as
-- sent. The text and headers are kept until it is sent (or given up on) so the 15-minute cron can send it again.
-- Logic in src/notify.ts (sendEmail, retryEmails).

ALTER TABLE notifications ADD COLUMN body TEXT;
ALTER TABLE notifications ADD COLUMN headers_json TEXT;
ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN sent_at INTEGER;

CREATE INDEX notifications_retry ON notifications (status, created_at) WHERE body IS NOT NULL;
