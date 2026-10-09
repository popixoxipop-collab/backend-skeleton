import { Router } from 'express';
import { handler } from '../controllers';

export function crud(_resource: string) {
  const router = Router();
  router.get('/', handler);
  router.post('/', handler);
  return router;
}
