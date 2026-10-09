import { Hono } from 'hono';
import { users } from './users.js';
import { v1 } from './v1.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/users', users);
app.route('/api', v1);

export default app;
