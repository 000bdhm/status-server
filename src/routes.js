import { authenticateDevice, generateToken, hashToken, isAdmin } from './auth.js';
import { checkMonitor } from './monitor.js';

const TYPES = new Set(['http', 'https', 'tcp']);
const STATUSES = new Set(['ok', 'degraded', 'down']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function requireAdmin(request, env) {
  if (!isAdmin(request, env)) throw new HttpError(401, 'invalid or missing X-Admin-Key');
}

function parseHistoryQuery(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  return { limit, offset };
}

const DEVICE_LIST_SQL = `
  SELECT d.id, d.name, d.description, d.created_at,
         s.device_id IS NOT NULL AS has_status,
         s.status, s.cpu, s.memory, s.uptime, s.message, s.created_at AS last_report_at
  FROM devices d
  LEFT JOIN device_status s ON s.id = (SELECT id FROM device_status
                                       WHERE device_id = d.id ORDER BY id DESC LIMIT 1)
  ORDER BY d.created_at ASC`;

const MONITOR_LIST_SQL = `
  SELECT m.id, m.name, m.type, m.url, m.host, m.port, m.interval_sec, m.enabled,
         m.last_checked_at,
         r.status AS last_status, r.status_code AS last_status_code,
         r.response_ms AS last_response_ms, r.error AS last_error, r.checked_at AS last_result_at
  FROM monitors m
  LEFT JOIN monitor_results r ON r.id = (SELECT id FROM monitor_results
                                         WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1)
  ORDER BY m.created_at ASC`;

const MONITOR_BY_ID_SQL = `
  SELECT m.id, m.name, m.type, m.url, m.host, m.port, m.method, m.expected_code,
         m.interval_sec, m.timeout_ms, m.enabled, m.created_at, m.last_checked_at,
         r.status AS last_status, r.status_code AS last_status_code,
         r.response_ms AS last_response_ms, r.error AS last_error, r.checked_at AS last_result_at
  FROM monitors m
  LEFT JOIN monitor_results r ON r.id = (SELECT id FROM monitor_results
                                         WHERE monitor_id = m.id ORDER BY id DESC LIMIT 1)
  WHERE m.id = ?`;

function sanitizeMonitor(body, existing = {}) {
  const type = body.type ?? existing.type;
  if (typeof type !== 'string' || !TYPES.has(type)) {
    throw new HttpError(400, `type must be one of: ${[...TYPES].join(', ')}`);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : existing.name;
  if (!name) throw new HttpError(400, 'name is required');

  const m = {
    type,
    name,
    url: body.url !== undefined ? body.url : existing.url,
    host: body.host !== undefined ? body.host : existing.host,
    port: body.port !== undefined ? body.port : existing.port,
    method: body.method || existing.method || 'GET',
    expected_code: body.expected_code !== undefined ? body.expected_code : existing.expected_code,
    interval_sec: Math.max(60, Number(body.interval_sec) || existing.interval_sec || 60),
    timeout_ms: Math.max(500, Number(body.timeout_ms) || existing.timeout_ms || 10000),
    enabled: body.enabled === undefined ? (existing.enabled ?? 1) : body.enabled ? 1 : 0,
  };

  if (type === 'tcp') {
    if (typeof m.host !== 'string' || !m.host.trim()) throw new HttpError(400, 'tcp monitor requires host');
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) {
      throw new HttpError(400, 'tcp monitor requires a valid port (1-65535)');
    }
  } else {
    if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) {
      throw new HttpError(400, 'url must start with http:// or https://');
    }
    if (!['GET', 'HEAD', 'POST'].includes(m.method)) {
      throw new HttpError(400, 'method must be GET, HEAD or POST');
    }
  }
  m.url = m.url ?? null;
  m.host = m.host ?? null;
  m.port = m.port ?? null;
  m.expected_code = m.expected_code ?? null;
  return m;
}

async function getDeviceOr404(env, id) {
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
  if (!device) throw new HttpError(404, 'device not found');
  return device;
}

async function getMonitorOr404(env, id) {
  const monitor = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(id).first();
  if (!monitor) throw new HttpError(404, 'monitor not found');
  return monitor;
}

async function recordMonitorResult(env, monitor, result) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO monitor_results (monitor_id, status, status_code, response_ms, error, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(monitor.id, result.status, result.statusCode ?? null, result.responseMs, result.error ?? null, now),
    env.DB.prepare('UPDATE monitors SET last_checked_at = ? WHERE id = ?').bind(now, monitor.id),
  ]);
}

// ---- handlers -----------------------------------------------------------

async function health() {
  return json({ ok: true });
}

async function pushStatus(request, env) {
  const device = await authenticateDevice(request, env);
  if (!device) throw new HttpError(401, 'invalid or missing device token');
  const body = await readBody(request);
  const { status, cpu, memory, uptime, message, timestamp } = body;
  if (!STATUSES.has(status)) {
    throw new HttpError(400, `status must be one of: ${[...STATUSES].join(', ')}`);
  }
  const at = Number.isInteger(timestamp) && timestamp > 0 ? timestamp : Date.now();
  await env.DB.prepare(
    `INSERT INTO device_status (device_id, status, cpu, memory, uptime, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(device.id, status, cpu ?? null, memory ?? null, uptime ?? null, message ?? null, at).run();
  return json({ ok: true, receivedAt: at }, 202);
}

async function createDevice(request, env) {
  requireAdmin(request, env);
  const body = await readBody(request);
  const name = body?.name;
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
  const token = generateToken();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO devices (id, name, description, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, name.trim(), (body?.description ?? '').trim(), await hashToken(token), Date.now()).run();
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(id).first();
  return json(
    { device, token, note: 'Store this token securely — it is shown once and never again.' },
    201,
  );
}

async function listDevices(request, env) {
  requireAdmin(request, env);
  return json({ devices: (await env.DB.prepare(DEVICE_LIST_SQL).all()).results });
}

async function deleteDevice(request, env, match) {
  requireAdmin(request, env);
  const device = await getDeviceOr404(env, match[1]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_status WHERE device_id = ?').bind(device.id),
    env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id),
  ]);
  return json({ ok: true });
}

async function rotateToken(request, env, match) {
  requireAdmin(request, env);
  const device = await getDeviceOr404(env, match[1]);
  const token = generateToken();
  await env.DB.prepare('UPDATE devices SET token_hash = ? WHERE id = ?')
    .bind(await hashToken(token), device.id)
    .run();
  return json({ deviceId: device.id, token, note: 'Old token is immediately invalidated.' });
}

async function createMonitor(request, env) {
  requireAdmin(request, env);
  const m = sanitizeMonitor(await readBody(request));
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO monitors (id, name, type, url, host, port, method, expected_code, interval_sec, timeout_ms, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, m.name, m.type, m.url, m.host, m.port, m.method, m.expected_code,
    m.interval_sec, m.timeout_ms, m.enabled, Date.now(),
  ).run();

  const monitor = await getMonitorOr404(env, id);
  const result = await checkMonitor(monitor);
  await recordMonitorResult(env, monitor, result);
  return json({ monitor: await env.DB.prepare(MONITOR_BY_ID_SQL).bind(id).first() }, 201);
}

async function listMonitors(request, env) {
  requireAdmin(request, env);
  return json({ monitors: (await env.DB.prepare(MONITOR_LIST_SQL).all()).results });
}

async function updateMonitor(request, env, match) {
  requireAdmin(request, env);
  const existing = await getMonitorOr404(env, match[1]);
  const m = sanitizeMonitor(await readBody(request), existing);
  await env.DB.prepare(
    `UPDATE monitors SET name=?, type=?, url=?, host=?, port=?, method=?,
     expected_code=?, interval_sec=?, timeout_ms=?, enabled=? WHERE id=?`,
  ).bind(
    m.name, m.type, m.url, m.host, m.port, m.method, m.expected_code,
    m.interval_sec, m.timeout_ms, m.enabled, existing.id,
  ).run();
  return json({ monitor: await env.DB.prepare(MONITOR_BY_ID_SQL).bind(existing.id).first() });
}

async function deleteMonitor(request, env, match) {
  requireAdmin(request, env);
  const monitor = await getMonitorOr404(env, match[1]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM monitor_results WHERE monitor_id = ?').bind(monitor.id),
    env.DB.prepare('DELETE FROM monitors WHERE id = ?').bind(monitor.id),
  ]);
  return json({ ok: true });
}

async function manualCheck(request, env, match) {
  requireAdmin(request, env);
  const monitor = await getMonitorOr404(env, match[1]);
  const result = await checkMonitor(monitor);
  await recordMonitorResult(env, monitor, result);
  return json({ ...result, monitorId: monitor.id });
}

async function buildAggregate(env, { isPublic = false } = {}) {
  const devices = (await env.DB.prepare(DEVICE_LIST_SQL).all()).results.map((d) => ({
    id: d.id,
    name: isPublic ? String(d.name).replace(/-[A-Z0-9]+$/i, '-XXXXXXX') : d.name,
    description: d.description,
    status: d.has_status ? d.status : 'unknown',
    cpu: isPublic && d.cpu != null ? Math.round(d.cpu * 1000) / 10 : (d.cpu ?? null),
    memory: isPublic && d.memory != null ? Math.round(d.memory * 1000) / 10 : (d.memory ?? null),
    uptime: d.uptime ?? null,
    message: isPublic && d.message != null ? String(d.message).replace(/-[A-Z0-9]+$/i, '-XXXXXXX') : (d.message ?? null),
    lastReportAt: d.last_report_at ?? null,
  }));
  const monitors = (await env.DB.prepare(MONITOR_LIST_SQL).all()).results.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    target: m.type === 'tcp' ? `${m.host}:${m.port}` : m.url,
    enabled: !!m.enabled,
    intervalSec: m.interval_sec,
    status: m.last_checked_at ? m.last_status : 'never_checked',
    statusCode: m.last_status_code ?? null,
    responseMs: m.last_response_ms ?? null,
    error: m.last_error ?? null,
    lastCheckedAt: m.last_checked_at ?? null,
  }));
  return { devices, monitors };
}

async function aggregateStatus(request, env) {
  requireAdmin(request, env);
  return json(await buildAggregate(env));
}

async function publicStatus(_request, env) {
  return json(await buildAggregate(env, { isPublic: true }));
}

async function deviceHistory(request, env, match, url) {
  requireAdmin(request, env);
  await getDeviceOr404(env, match[1]);
  const { limit, offset } = parseHistoryQuery(url);
  const events = (
    await env.DB.prepare(
      `SELECT status, cpu, memory, uptime, message, created_at AS timestamp
       FROM device_status WHERE device_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(match[1], limit, offset)
      .all()
  ).results;
  return json({ deviceId: match[1], events });
}

async function monitorHistory(request, env, match, url) {
  requireAdmin(request, env);
  await getMonitorOr404(env, match[1]);
  const { limit, offset } = parseHistoryQuery(url);
  const events = (
    await env.DB.prepare(
      `SELECT status, status_code AS statusCode, response_ms AS responseMs, error, checked_at AS timestamp
       FROM monitor_results WHERE monitor_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(match[1], limit, offset)
      .all()
  ).results;
  return json({ monitorId: match[1], events });
}

const routes = [
  { method: 'GET', pattern: /^\/health$/, handler: health },
  { method: 'POST', pattern: /^\/api\/v1\/status$/, handler: pushStatus },
  { method: 'POST', pattern: /^\/api\/v1\/devices$/, handler: createDevice },
  { method: 'GET', pattern: /^\/api\/v1\/devices$/, handler: listDevices },
  { method: 'DELETE', pattern: /^\/api\/v1\/devices\/([^/]+)$/, handler: deleteDevice },
  { method: 'POST', pattern: /^\/api\/v1\/devices\/([^/]+)\/rotate-token$/, handler: rotateToken },
  { method: 'POST', pattern: /^\/api\/v1\/monitors$/, handler: createMonitor },
  { method: 'GET', pattern: /^\/api\/v1\/monitors$/, handler: listMonitors },
  { method: 'PUT', pattern: /^\/api\/v1\/monitors\/([^/]+)$/, handler: updateMonitor },
  { method: 'DELETE', pattern: /^\/api\/v1\/monitors\/([^/]+)$/, handler: deleteMonitor },
  { method: 'POST', pattern: /^\/api\/v1\/monitors\/([^/]+)\/check$/, handler: manualCheck },
  { method: 'GET', pattern: /^\/api\/device-status$/, handler: publicStatus },
  { method: 'GET', pattern: /^\/api\/v1\/status$/, handler: aggregateStatus },
  { method: 'GET', pattern: /^\/api\/v1\/status\/devices\/([^/]+)\/history$/, handler: deviceHistory },
  { method: 'GET', pattern: /^\/api\/v1\/status\/monitors\/([^/]+)\/history$/, handler: monitorHistory },
];

export default async function handleRequest(request, env) {
  const url = new URL(request.url);
  try {
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;
      return await route.handler(request, env, match, url);
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err.message || 'internal error' }, status);
  }
}
