import Router from '@koa/router';

export function crud(resource) {
  const router = new Router({ prefix: `/${resource}` });
  router.get('/', (ctx) => {
    ctx.body = { resource, list: [] };
  });
  router.post('/', (ctx) => {
    ctx.status = 201;
    ctx.body = { resource };
  });
  return router;
}
