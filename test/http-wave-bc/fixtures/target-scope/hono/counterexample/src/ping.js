import { Hono } from 'hono';

export const ping = new Hono();

ping.get('/ping', (c) => c.json({ pong: true }));
