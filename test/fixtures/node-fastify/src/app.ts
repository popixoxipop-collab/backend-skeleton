import Fastify from 'fastify';
import users from './users.js';

const app = Fastify();
app.get('/health', async () => ({ ok: true }));
app.register(users, { prefix: '/v1' });
