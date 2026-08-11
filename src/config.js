import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let adminKey = process.env.ADMIN_KEY?.trim();
if (!adminKey) {
  adminKey = crypto.randomBytes(32).toString('base64url');
  console.warn(`[config] No ADMIN_KEY set — generated a random one:\n  ADMIN_KEY=${adminKey}\n`);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  adminKey,
  dbPath: path.resolve(ROOT, process.env.DB_PATH?.trim() || 'data'),
};
