import crypto from 'node:crypto';
import { db, getLatestDevice, listDevices } from '../db.js';
import { authenticateAdmin, generateToken, hashToken } from '../auth.js';

function findDeviceOr404(reply, id) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) reply.code(404).send({ error: 'device not found' });
  return device;
}

export default async function deviceRoutes(app) {
  const admin = { preHandler: authenticateAdmin };

  app.post('/api/v1/devices', admin, async (req, reply) => {
    const { name, description } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const token = generateToken();
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO devices (id, name, description, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name.trim(), description?.trim() ?? '', hashToken(token), Date.now());

    reply.code(201).send({
      device: getLatestDevice(id),
      token,
      note: 'Store this token securely — it is shown once and never again.',
    });
  });

  app.get('/api/v1/devices', admin, async (_req, reply) => {
    reply.send({ devices: listDevices().map((d) => getLatestDevice(d.id)) });
  });

  app.delete('/api/v1/devices/:id', admin, async (req, reply) => {
    const device = findDeviceOr404(reply, req.params.id);
    if (!device) return;
    db.transaction(() => {
      db.prepare('DELETE FROM device_status WHERE device_id = ?').run(device.id);
      db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
    })();
    reply.send({ ok: true });
  });

  app.post('/api/v1/devices/:id/rotate-token', admin, async (req, reply) => {
    const device = findDeviceOr404(reply, req.params.id);
    if (!device) return;
    const token = generateToken();
    db.prepare('UPDATE devices SET token_hash = ? WHERE id = ?').run(hashToken(token), device.id);
    reply.send({ deviceId: device.id, token, note: 'Old token is immediately invalidated.' });
  });
}
