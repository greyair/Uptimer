CREATE TABLE IF NOT EXISTS globalping_history (
  monitor_id INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  results_json TEXT NOT NULL,
  PRIMARY KEY (monitor_id, checked_at),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_globalping_history_monitor_checked
  ON globalping_history(monitor_id, checked_at DESC);
