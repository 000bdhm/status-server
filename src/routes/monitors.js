import crypto from 'node:crypto';
import { db, getLatestMonitor, listMonitors } from '../db.js';
import { authenticateAdmin } from '../auth.js';
import { checkMonitor, startMonitorTimer, stopMonitorTimer } from '../monitor/checker.js';

const TYPES = new Set(['http', 'https', 'tcp']);

function sanitize(body) {
  const m = {};
  const type = body.type;
  if (typeof type !== 'string' || !TYPES.has(type)) {
    const err = new Error(`type must be one of: ${[...TYPES].join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  m.type = type;
  m.name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!m.name) {
    const err = new Error('name is required');
    err.statusCode = 400;
    throw err;
  }
  m.url = body.url;
  m.host = body.host;
  m.port = body.port;
  m.method = body.method || 'GET';
  m.expected_code = body.expected_code;
  m.interval_sec = Math.max(5, Number(body.interval_sec) || 60);
  m.timeout_ms = Math.max(500, Number(body.timeout_ms) || 10000);
  m.enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;

  if (type === 'tcp') {
    if (typeof m.host !== 'string' || !m.host.trim()) {
      const err = new Error('tcp monitor requires host');
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) {
      const err = new Error('tcp monitor requires a valid port (1-65535)');
      err.statusCode = 400;
      throw err;
    }
  } else {
    if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) {
      const err = new Error('url must start with http:// or https://');
      err.statusCode = 400;
      throw err;
    }
    if (!['GET', 'HEAD', 'POST'].includes(m.method)) {
      const err = new Error('method must be GET, HEAD or POST');
      err.statusCode = 400;
      throw err;
    }
  }
  return m;
}

function findMonitorOr404(reply, id) {
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
  if (!monitor) reply.code(404).send({ error: 'monitor not found' });
  return monitor;
}

function refreshTimer(id) {
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);
  if (monitor) startMonitorTimer(monitor);
}

export default async function monitorRoutes(app) {
  const admin = { preHandler: authenticateAdmin };

  app.post('/api/v1/monitors', admin, async (req, reply) => {
    const m = sanitize(req.body ?? {});
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO monitors (id, name, type, url, host, port, method, expected_code, interval_sec, timeout_ms, enabled, created_at)
       VALUES (@id, @name, @type, @url, @host, @port, @method, @expected_code, @interval_sec, @timeout_ms, @enabled, @created_at)`,
    ).run({ ...m, id, created_at: Date.now() });
    refreshTimer(id);
    reply.code(201).send({ monitor: getLatestMonitor(id) });
  });

  app.get('/api/v1/monitors', admin, async (_req, reply) => {
    reply.send({ monitors: listMonitors().map((m) => getLatestMonitor(m.id)) });
  });

  app.put('/api/v1/monitors/:id', admin, async (req, reply) => {
    const existing = findMonitorOr404(reply, req.params.id);
    if (!existing) return;
    const body = { ...req.body };
    body.type = body.type || existing.type;
    body.name = body.name ?? existing.name;
    if (body.url === undefined) body.url = existing.url;
    if (body.host === undefined) body.host = existing.host;
    if (body.port === undefined) body.port = existing.port;
    if (body.method === undefined) body.method = existing.method;
    if (body.expected_code === undefined) body.expected_code = existing.expected_code;
    if (body.interval_sec === undefined) body.interval_sec = existing.interval_sec;
    if (body.timeout_ms === undefined) body.timeout_ms = existing.timeout_ms;
    if (body.enabled === undefined) body.enabled = !!existing.enabled;

    const m = sanitize(body);
    db.prepare(
      `UPDATE monitors SET name=@name, type=@type, url=@url, host=@host, port=@port,
       method=@method, expected_code=@expected_code, interval_sec=@interval_sec,
       timeout_ms=@timeout_ms, enabled=@enabled WHERE id=@id`,
    ).run({ ...m, id: existing.id });
    refreshTimer(existing.id);
    reply.send({ monitor: getLatestMonitor(existing.id) });
  });

  app.delete('/api/v1/monitors/:id', admin, async (req, reply) => {
    const monitor = findMonitorOr404(reply, req.params.id);
    if (!monitor) return;
    stopMonitorTimer(monitor.id);
    db.transaction(() => {
      db.prepare('DELETE FROM monitor_results WHERE monitor_id = ?').run(monitor.id);
      db.prepare('DELETE FROM monitors WHERE id = ?').run(monitor.id);
    })();
    reply.send({ ok: true });
  });

  app.post('/api/v1/monitors/:id/check', admin, async (req, reply) => {
    const monitor = findMonitorOr404(reply, req.params.id);
    if (!monitor) return;
    const result = await checkMonitor(monitor);
    reply.send({ ...result, monitorId: monitor.id, monitor: getLatestMonitor(monitor.id) });
  });
}
