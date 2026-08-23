// The OTHER real plain-JS idiom: a named `Router` import, same as the TypeScript oracle's. Both
// forms have to work -- a real repo routinely mixes them file to file.
import { Router } from 'express';
import { getOrder, searchOrders } from '../controllers/order.controller.js';

const router = Router();

router.get('/search', searchOrders);
router.get('/:orderId', getOrder);

// Retired 2026-05: superseded by GET /search.
// router.get('/legacy-list', listAllOrders);
/* router.post('/bulk-import', bulkImportOrders); */

export default router;
