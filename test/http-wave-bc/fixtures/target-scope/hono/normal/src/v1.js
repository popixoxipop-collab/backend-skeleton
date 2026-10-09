import { Hono } from 'hono';

export const v1 = new Hono().basePath('/v1');

v1.get('/status', (c) => c.json({ status: 'up' }));
v1.delete('/sessions/:sid', (c) => c.body(null, 204));
