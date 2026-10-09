import Koa from 'koa';
import Router from '@koa/router';
import { crud } from './factory.js';
import { requireAuth } from './auth.js';

const app = new Koa();
const api = new Router({ prefix: '/api' });
const secured = new Router({ prefix: '/secure' });
const gen = new Router();
const deployed = new Router({ prefix: process.env.API_BASE ?? '/svc' });
const misc = new Router();
const legacy = new Router();
const nested = new Router();
const child = new Router();

api.get('/status', (ctx) => { ctx.body = { ok: true }; }); // constructor prefix over a same-file router

secured.use(requireAuth); // router-level auth middleware
secured.get('/data', (ctx) => { ctx.body = { secret: true }; });

for (const name of ['alpha', 'beta']) {
  gen.get(`/gen/${name}`, (ctx) => { ctx.body = { name }; }); // paths generated in a loop
}

deployed.get('/ping', (ctx) => { ctx.body = { pong: true }; }); // prefix decided at start-up

misc.get('/chain', (ctx) => { ctx.body = 'get'; }).post('/chain', (ctx) => { ctx.body = 'post'; }); // chained verb calls
misc.all('/any', (ctx) => { ctx.body = 'any'; });
misc.get(['/a1', '/a2'], (ctx) => { ctx.body = 'array'; });

legacy.get('/old', (ctx) => { ctx.body = 'old'; });
legacy.prefix('/legacy'); // prefix() mutation after the routes were declared

child.get('/leaf', (ctx) => { ctx.body = 'leaf'; });
nested.use('/nested', child.routes()); // nested router mounted through use()

app.use(api.routes());
app.use(secured.routes());
app.use(gen.routes());
app.use(deployed.routes());
app.use(misc.routes());
app.use(legacy.routes());
app.use(nested.routes());
app.use(crud('widgets').routes()); // router built by a function call in another file

export default app;
