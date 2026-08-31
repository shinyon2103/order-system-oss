CREATE TABLE order_number_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  online_start_number INTEGER NOT NULL CHECK (online_start_number >= 0),
  online_end_number INTEGER NOT NULL CHECK (online_end_number >= online_start_number),
  online_next_number INTEGER NOT NULL CHECK (online_next_number >= online_start_number),
  offline_prefix TEXT NOT NULL,
  offline_start_number INTEGER NOT NULL CHECK (offline_start_number >= 0),
  offline_next_number INTEGER NOT NULL CHECK (offline_next_number >= offline_start_number)
);

INSERT INTO order_number_settings (
  id,
  online_start_number,
  online_end_number,
  online_next_number,
  offline_prefix,
  offline_start_number,
  offline_next_number
) VALUES ('default', 100, 500, 100, 'OFF-', 1000, 1000);

CREATE TABLE app_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'default'),
  session_duration_minutes INTEGER NOT NULL DEFAULT 480 CHECK (session_duration_minutes > 0),
  reauth_grace_minutes INTEGER NOT NULL DEFAULT 30 CHECK (reauth_grace_minutes >= 0)
);

INSERT INTO app_settings (id, session_duration_minutes, reauth_grace_minutes)
VALUES ('default', 480, 30);
