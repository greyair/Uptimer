CREATE TABLE IF NOT EXISTS monitor_extensions (
  monitor_id INTEGER PRIMARY KEY,
  probe_mode TEXT NOT NULL DEFAULT 'direct' CHECK (probe_mode IN ('direct', 'globalping')),
  globalping_locations_json TEXT,

  ssl_check_enabled INTEGER NOT NULL DEFAULT 0,
  ssl_warn_days INTEGER NOT NULL DEFAULT 30,
  ssl_last_checked_at INTEGER,
  ssl_expires_at INTEGER,
  ssl_error TEXT,

  domain_name TEXT,
  domain_warn_days INTEGER NOT NULL DEFAULT 30,
  domain_last_checked_at INTEGER,
  domain_expires_at INTEGER,
  domain_error TEXT,

  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_monitor_extensions_ssl_due
  ON monitor_extensions (ssl_check_enabled, ssl_last_checked_at);

CREATE INDEX IF NOT EXISTS idx_monitor_extensions_domain_due
  ON monitor_extensions (domain_name, domain_last_checked_at);
