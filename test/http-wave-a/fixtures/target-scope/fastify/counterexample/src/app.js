import Fastify from 'fastify';
import admin from './admin.js';
import members from './members.js';
import { crud } from './crud.js';

export function build() {
  const app = Fastify();
  const base = process.env.API_BASE ?? '/svc';
  app.get('/open', async () => 'open');
  app.register(admin, { prefix: '/admin' }); // plugin whose onRequest hook guards every route in it
  for (const name of ['alpha', 'beta']) {
    app.get(`/gen/${name}`, async () => ({ name })); // paths generated in a loop
  }
  app.register(crud('widgets'), { prefix: '/widgets' }); // plugin produced by a factory function
  app.register(members, { prefix: base }); // prefix decided at start-up
  app.route({ method: ['GET', 'POST'], url: '/multi', handler: async () => 'multi' }); // one route() call, two methods
  app.all('/any', async () => 'any');
  app.route({ method: 'GET', url: '/explicit', handler: async () => 'explicit' }); // object-form route
  return app;
}
