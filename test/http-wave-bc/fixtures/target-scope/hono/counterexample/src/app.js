import { Hono } from 'hono';
import { crud } from './factory.js';
import { members } from './members.js';
import { ping } from './ping.js';

const app = new Hono();
const base = process.env.API_BASE ?? '/svc';

app.get('/open', (c) => c.json({ ok: true }));
app.use('/secret/*', async (c, next) => {
  if (!c.req.header('x-token')) return c.json({ error: 'unauthorized' }, 401);
  await next();
}); // auth middleware guarding everything under /secret
app.get('/secret/data', (c) => c.json({ secret: true }));
for (const name of ['alpha', 'beta']) {
  app.get(`/gen/${name}`, (c) => c.json({ name })); // paths generated in a loop
}
app.route('/widgets', crud('widgets')); // sub-app built by a function call
app.route(base, ping); // mount path decided at start-up by the environment
app.route('/orgs/:org', members); // parameterised mount path over an imported sub-app
app.get('/chain', (c) => c.json({ ok: true })).post('/chain', (c) => c.json({ ok: true })); // chained verb calls
app.all('/any', (c) => c.json({ ok: true }));
app.on('GET', ['/a1', '/a2'], (c) => c.json({ ok: true }));
app.mount('/legacy', (request) => new Response(`legacy ${new URL(request.url).pathname}`)); // foreign fetch handler

export default app;
