CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  status     TEXT NOT NULL,
  cpu        REAL,
  memory     REAL,
  uptime     REAL,
  message    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_status_device ON device_status (device_id, id);

CREATE TABLE IF NOT EXISTS monitors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  url             TEXT,
  host            TEXT,
  port            INTEGER,
  method          TEXT NOT NULL DEFAULT 'GET',
  expected_code   INTEGER,
  interval_sec    INTEGER NOT NULL DEFAULT 60,
  timeout_ms      INTEGER NOT NULL DEFAULT 10000,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  status_code INTEGER,
  response_ms REAL,
  error       TEXT,
  checked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_results_monitor ON monitor_results (monitor_id, id);
