-- Why Cloudflare URL Scanner did not scan a link (the API's error), shown with the link check results.
ALTER TABLE page_links ADD COLUMN scan_error TEXT;
