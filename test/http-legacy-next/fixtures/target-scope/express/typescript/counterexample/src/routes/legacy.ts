import { Router } from 'express';
import { handler } from '../controllers';

const router = Router();
router.get('/old', handler);

export { router as legacyRouter };
