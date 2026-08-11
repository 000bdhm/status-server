import net from 'node:net';
import { db } from '../db.js';

export async function checkMonitor(monitor) {
  const started = performance.now();
  try {
    if (monitor.type === 'tcp') {
      await tcpProbe(monitor);
    } else if (monitor.type === 'http' || monitor.type === 'https') {
      await httpProbe(monitor);
    } else {
      throw new Error(`unsupported monitor type: ${monitor.type}`);
    }
    const ms = performance.now() - started;
    db.prepare(
      `INSERT INTO monitor_results (monitor_id, status, status_code, response_ms, error, checked_at)
       VALUES (?, 'ok', NULL, ?, NULL, ?)`,
    ).run(monitor.id, ms, Date.now());
    return { status: 'ok', responseMs: ms };
  } catch (err) {
    const ms = performance.now() - started;
    const error = err.message;
    db.prepare(
      `INSERT INTO monitor_results (monitor_id, status, status_code, response_ms, error, checked_at)
       VALUES (?, 'down', NULL, ?, ?, ?)`,
    ).run(monitor.id, ms, error, Date.now());
    return { status: 'down', responseMs: ms, error };
  }
}

function httpProbe(monitor) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, monitor.timeout_ms || 10000);

    const headers = { 'user-agent': 'status-server/1.0' };
    if (monitor.expected_code != null) {
      headers['accept'] = '*/*';
    }

    fetch(monitor.url, { method: monitor.method || 'GET', headers, signal: controller.signal })
      .then(async (res) => {
        await res.body?.cancel();
        clearTimeout(timer);
        const code = res.status;
        if (monitor.expected_code != null && code !== monitor.expected_code) {
          throw new Error(`expected status ${monitor.expected_code}, got ${code}`);
        }
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        if (err.name === 'AbortError') reject(new Error('timeout'));
        else reject(err);
      });
  });
}

function tcpProbe(monitor) {
  return new Promise((resolve, reject) => {
    if (!monitor.host) return reject(new Error('tcp monitor requires host'));
    const port = monitor.port;
    if (!port) return reject(new Error('tcp monitor requires port'));

    const socket = new net.Socket();
    const timeout = monitor.timeout_ms || 10000;
    socket.setTimeout(timeout);

    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', (err) => reject(err));
    socket.connect(port, monitor.host);
  });
}

const timers = new Map();

export function startMonitorTimer(monitor) {
  stopMonitorTimer(monitor.id);
  if (!monitor.enabled) return;
  const interval = Math.max(5, monitor.interval_sec || 60) * 1000;
  const run = () => checkMonitor(monitor);
  run();
  timers.set(monitor.id, setInterval(run, interval));
}

export function stopMonitorTimer(id) {
  const t = timers.get(id);
  if (t) {
    clearInterval(t);
    timers.delete(id);
  }
}

export function stopAllTimers() {
  for (const id of [...timers.keys()]) stopMonitorTimer(id);
}

export function refreshAllTimers() {
  const monitors = db.prepare('SELECT * FROM monitors').all();
  for (const m of monitors) startMonitorTimer(m);
}
