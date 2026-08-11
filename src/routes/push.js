import { db } from '../db.js';
import { authenticateDevice } from '../auth.js';

const STATUSES = new Set(['ok', 'degraded', 'down']);

export default async function pushRoutes(app) {
  app.post(
    '/api/v1/status',
    {
      preHandler: authenticateDevice,
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string' },
            cpu: { type: 'number' },
            memory: { type: 'number' },
            uptime: { type: 'number' },
            message: { type: 'string', maxLength: 2000 },
            timestamp: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { status, cpu, memory, uptime, message, timestamp } = req.body;
      if (!STATUSES.has(status)) {
        return reply.code(400).send({ error: `status must be one of: ${[...STATUSES].join(', ')}` });
      }
      const at = typeof timestamp === 'number' && timestamp > 0 ? timestamp : Date.now();

      db.prepare(
        `INSERT INTO device_status (device_id, status, cpu, memory, uptime, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(req.device.id, status, cpu ?? null, memory ?? null, uptime ?? null, message ?? null, at);

      reply.code(202).send({ ok: true, receivedAt: at });
    },
  );
}
