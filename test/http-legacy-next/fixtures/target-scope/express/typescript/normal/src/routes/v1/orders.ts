import { Router } from 'express';
import { search, getOrder } from '../../controllers/handlers';

const router = Router();

router.get('/search', search);
router.get('/:orderId', getOrder);

export default router;
