import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const api = new Router({ prefix: '/api' });
const root = new Router();

api.get('/health', (ctx) => {
  ctx.body = { ok: true };
});
api.get('users', '/users', (ctx) => {
  ctx.body = [];
});
api.post('/users', (ctx) => {
  ctx.status = 201;
  ctx.body = { created: true };
});
api.get('/users/:id', (ctx) => {
  ctx.body = { id: ctx.params.id };
});
api.delete('/users/:id', (ctx) => {
  ctx.status = 204;
});
root.get('/', (ctx) => {
  ctx.body = 'index';
});

app.use(api.routes());
app.use(root.routes());

export default app;
