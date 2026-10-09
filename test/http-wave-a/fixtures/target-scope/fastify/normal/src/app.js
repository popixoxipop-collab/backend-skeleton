import Fastify from 'fastify';
import users from './users.js';

export function build() {
  const app = Fastify();
  app.get('/health', async () => ({ ok: true }));
  app.register(users, { prefix: '/users' });
  return app;
}
