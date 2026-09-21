ALTER TABLE monitor_extensions ADD COLUMN globalping_last_results_json TEXT;
ALTER TABLE monitor_extensions ADD COLUMN globalping_last_checked_at INTEGER;

-- Force existing SSL-enabled monitors to retry immediately after switching
-- from Workers node:tls peer inspection to Globalping TLS metadata.
UPDATE monitor_extensions
SET ssl_last_checked_at = NULL,
    ssl_error = NULL
WHERE ssl_check_enabled = 1;
