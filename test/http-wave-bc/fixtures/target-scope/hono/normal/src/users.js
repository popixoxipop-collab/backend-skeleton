import { Hono } from 'hono';

export const users = new Hono();

users.get('/', (c) => c.json([]));
users.post('/', (c) => c.json({ created: true }, 201));
users.get('/:id', (c) => c.json({ id: c.req.param('id') }));
