import { Router } from 'express';
import { handler } from '../controllers.js';

const router = Router();
router.get('/ping', handler);

export default router;
