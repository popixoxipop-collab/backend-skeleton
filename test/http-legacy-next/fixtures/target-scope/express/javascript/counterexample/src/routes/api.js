import { Router } from 'express';
import { handler } from '../controllers.js';

const router = Router();
router.get('/status', handler);

export default router;
