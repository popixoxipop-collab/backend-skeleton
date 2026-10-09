import { Router } from 'express';
import { searchOrders, getOrder } from '../controllers/handlers.js';

const router = Router();

router.get('/search', searchOrders);
router.get('/:orderId', getOrder);

export default router;
