import { db, getLatestDevice, getLatestMonitor, listDevices, listMonitors } from '../db.js';
import { authenticateAdmin } from '../auth.js';

function limitFromQuery(q) {
  const n = Number(q?.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 100;
  const o = Number(q?.offset);
  const offset = Number.isFinite(o) && o > 0 ? Math.floor(o) : 0;
  return { limit, offset };
}

export default async function statusRoutes(app) {
  const admin = { preHandler: authenticateAdmin };

  app.get('/api/v1/status', admin, async (_req, reply) => {
    const devices = listDevices().map((d) => {
      const row = getLatestDevice(d.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.has_status ? row.status : 'unknown',
        cpu: row.cpu ?? null,
        memory: row.memory ?? null,
        uptime: row.uptime ?? null,
        message: row.message ?? null,
        lastReportAt: row.last_report_at ?? null,
      };
    });

    const monitors = listMonitors().map((m) => {
      const row = getLatestMonitor(m.id);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        target: row.type === 'tcp' ? `${row.host}:${row.port}` : row.url,
        enabled: !!row.enabled,
        intervalSec: row.interval_sec,
        status: row.last_checked_at ? row.last_status : 'never_checked',
        statusCode: row.last_status_code ?? null,
        responseMs: row.last_response_ms ?? null,
        error: row.last_error ?? null,
        lastCheckedAt: row.last_checked_at ?? null,
      };
    });

    reply.send({ devices, monitors });
  });

  app.get('/api/v1/status/devices/:id/history', admin, async (req, reply) => {
    const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
    if (!device) return reply.code(404).send({ error: 'device not found' });
    const { limit, offset } = limitFromQuery(req.query);
    const rows = db
      .prepare(
        `SELECT status, cpu, memory, uptime, message, created_at AS timestamp
         FROM device_status WHERE device_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(req.params.id, limit, offset);
    reply.send({ deviceId: req.params.id, events: rows });
  });

  app.get('/api/v1/status/monitors/:id/history', admin, async (req, reply) => {
    const monitor = db.prepare('SELECT id FROM monitors WHERE id = ?').get(req.params.id);
    if (!monitor) return reply.code(404).send({ error: 'monitor not found' });
    const { limit, offset } = limitFromQuery(req.query);
    const rows = db
      .prepare(
        `SELECT status, status_code AS statusCode, response_ms AS responseMs, error, checked_at AS timestamp
         FROM monitor_results WHERE monitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(req.params.id, limit, offset);
    reply.send({ monitorId: req.params.id, events: rows });
  });
}
