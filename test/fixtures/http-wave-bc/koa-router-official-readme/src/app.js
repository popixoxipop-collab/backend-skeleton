import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const router = new Router();

router.get('/', (ctx, next) => {
  ctx.body = 'Hello World!';
});

router.get('/users/:id', (ctx, next) => {
  ctx.body = { id: ctx.params.id };
});

app.use(router.routes()).use(router.allowedMethods());

app.listen(3000);
