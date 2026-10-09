import { Router } from 'express';
import { list, show, create } from '../../controllers/handlers';
import { checkJwt, checkRole } from '../../middleware/checkJwt';

const router = Router();

router.get('/', list);
// A middleware ARRAY whose second element is a call with its own array argument.
router.get('/:id([0-9]+)', [checkJwt, checkRole(['ADMIN'], true)], show);
router.post('/', checkJwt, create);
// Retired: router.delete('/:id', checkJwt, show);

export default router;
