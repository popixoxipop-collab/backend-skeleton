import { Hono } from 'hono';

export const members = new Hono();

members.get('/list', (c) => c.json([]));
