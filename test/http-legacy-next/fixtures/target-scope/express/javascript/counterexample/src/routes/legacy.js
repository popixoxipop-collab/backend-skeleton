import { Router } from 'express';
import { handler } from '../controllers.js';

const router = Router();
router.get('/old', handler);

export { router as legacyRouter };
