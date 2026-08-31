CREATE TABLE admin_login_limits (
  client_hash TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  blocked_until INTEGER
);
