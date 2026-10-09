import { Router } from 'express';
import { handler } from '../controllers';

const router = Router();
router.get('/ping', handler);

export default router;
