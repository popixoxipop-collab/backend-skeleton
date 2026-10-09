import { Router } from 'express';
import { handler } from '../controllers.js';

export function crud(_resource) {
  const router = Router();
  router.get('/', handler);
  router.post('/', handler);
  return router;
}
