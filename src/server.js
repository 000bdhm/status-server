import Fastify from 'fastify';
import { config } from './config.js';
import { refreshAllTimers, stopAllTimers } from './monitor/checker.js';
import pushRoutes from './routes/push.js';
import deviceRoutes from './routes/devices.js';
import monitorRoutes from './routes/monitors.js';
import statusRoutes from './routes/status.js';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, uptime: process.uptime() }));

app.register(deviceRoutes);
app.register(monitorRoutes);
app.register(pushRoutes);
app.register(statusRoutes);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  refreshAllTimers();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown(signal) {
  app.log.info(`received ${signal}, shutting down`);
  stopAllTimers();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
