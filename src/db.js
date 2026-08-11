import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dbPath, { recursive: true });

export const db = new Database(path.join(config.dbPath, 'status.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL,
    url            TEXT,
    host           TEXT,
    port           INTEGER,
    method         TEXT NOT NULL DEFAULT 'GET',
    expected_code  INTEGER,
    interval_sec   INTEGER NOT NULL DEFAULT 60,
    timeout_ms     INTEGER NOT NULL DEFAULT 10000,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL
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
`);

function getLatestDevice(deviceId) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.description, d.created_at, s.device_id IS NOT NULL AS has_status,
              s.status, s.cpu, s.memory, s.uptime, s.message, s.created_at AS last_report_at
       FROM devices d
       LEFT JOIN device_status s ON s.id = (SELECT id FROM device_status
                                            WHERE device_id = ? ORDER BY id DESC LIMIT 1)
       WHERE d.id = ?`,
    )
    .get(deviceId, deviceId);
}

export function latestDeviceStatus(deviceId) {
  return db
    .prepare(`SELECT * FROM device_status WHERE device_id = ? ORDER BY id DESC LIMIT 1`)
    .get(deviceId);
}

export function getLatestMonitor(monitorId) {
  return db
    .prepare(
      `SELECT m.*, r.status AS last_status, r.status_code AS last_status_code,
              r.response_ms AS last_response_ms, r.error AS last_error, r.checked_at AS last_checked_at
       FROM monitors m
       LEFT JOIN monitor_results r ON r.id = (SELECT id FROM monitor_results
                                              WHERE monitor_id = ? ORDER BY id DESC LIMIT 1)
       WHERE m.id = ?`,
    )
    .get(monitorId, monitorId);
}

export { getLatestDevice };

export function listDevices() {
  return db.prepare('SELECT id FROM devices ORDER BY created_at ASC').all();
}

export function listMonitors() {
  return db.prepare('SELECT id FROM monitors ORDER BY created_at ASC').all();
}
