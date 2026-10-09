import { Hono } from 'hono';

export function crud(resource) {
  const router = new Hono();
  router.get('/', (c) => c.json({ resource, list: [] }));
  router.post('/', (c) => c.json({ resource }, 201));
  return router;
}
