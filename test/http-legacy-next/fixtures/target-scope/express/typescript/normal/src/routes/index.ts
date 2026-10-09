import { Router } from 'express';
import v1 from './v1';
import { health } from '../controllers/handlers';

const router = Router();

router.get('/health', health);
router.use('/v1', v1);

export default router;
