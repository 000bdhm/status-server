import handleRequest from './routes.js';
import { runDueMonitors } from './monitor.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDueMonitors(env));
  },
};
