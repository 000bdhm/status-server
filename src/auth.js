import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function authenticateDevice(req, reply, done) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return reply.code(401).send({ error: 'missing Bearer token' });
  }
  const device = db
    .prepare('SELECT id, name FROM devices WHERE token_hash = ?')
    .get(hashToken(token));
  if (!device) {
    return reply.code(401).send({ error: 'invalid token' });
  }
  req.device = device;
  done();
}

export function authenticateAdmin(req, reply, done) {
  const key = req.headers['x-admin-key'];
  if (typeof key !== 'string' || !timingSafeEqualStr(key, config.adminKey)) {
    return reply.code(401).send({ error: 'invalid or missing X-Admin-Key' });
  }
  done();
}
