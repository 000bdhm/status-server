import { connect } from 'cloudflare:sockets';

export async function checkMonitor(monitor) {
  const started = performance.now();
  try {
    if (monitor.type === 'tcp') {
      await tcpProbe(monitor);
    } else {
      await httpProbe(monitor);
    }
    return { status: 'ok', responseMs: performance.now() - started };
  } catch (err) {
    return { status: 'down', responseMs: performance.now() - started, error: err.message || String(err) };
  }
}

function httpProbe(monitor) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeout_ms || 10000);
  return fetch(monitor.url, {
    method: monitor.method || 'GET',
    signal: controller.signal,
    headers: { 'user-agent': 'status-server/1.0' },
  })
    .then(async (res) => {
      await res.body?.cancel();
      clearTimeout(timer);
      if (monitor.expected_code != null && res.status !== monitor.expected_code) {
        throw new Error(`expected status ${monitor.expected_code}, got ${res.status}`);
      }
    })
    .catch((err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('timeout');
      throw err;
    });
}

function tcpProbe(monitor) {
  if (!monitor.host) return Promise.reject(new Error('tcp monitor requires host'));
  if (!monitor.port) return Promise.reject(new Error('tcp monitor requires port'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (!settled) {
        settled = true;
        fn(arg);
      }
    };
    let socket;
    try {
      socket = connect({ hostname: monitor.host, port: monitor.port });
    } catch (err) {
      return finish(reject, err);
    }
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      finish(reject, new Error('timeout'));
    }, monitor.timeout_ms || 10000);
    socket.opened
      .then(() => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        finish(resolve);
      })
      .catch((err) => {
        clearTimeout(timer);
        finish(reject, err);
      });
  });
}

export async function runDueMonitors(env) {
  const now = Date.now();
  const res = await env.DB.prepare('SELECT * FROM monitors WHERE enabled = 1').all();
  const results = await Promise.all(
    res.results.map(async (m) => {
      const due =
        m.last_checked_at == null || m.last_checked_at + Math.max(60, m.interval_sec) * 1000 <= now;
      if (!due) return null;
      const r = await checkMonitor(m);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO monitor_results (monitor_id, status, status_code, response_ms, error, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(m.id, r.status, r.statusCode ?? null, r.responseMs, r.error ?? null, now),
        env.DB.prepare('UPDATE monitors SET last_checked_at = ? WHERE id = ?').bind(now, m.id),
      ]);
      return { id: m.id, ...r };
    }),
  );
  return results.filter(Boolean);
}
