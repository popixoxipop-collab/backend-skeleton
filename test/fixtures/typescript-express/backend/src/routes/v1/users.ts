import { Router } from 'express';
import { show } from 'controllers/users';
import { checkJwt } from 'middleware/checkJwt';
import { checkRole } from 'middleware/checkRole';

const router = Router();

// A real, oracle-shaped complication: a middleware ARRAY whose own second element is a nested
// function call with its own array argument (checkRole(['ADMINISTRATOR'], true)) -- confirmed in
// the real oracle this provider was cross-checked against (mkosir/typeorm-express-typescript).
router.get('/:id([0-9]+)', [checkJwt, checkRole(['ADMINISTRATOR'], true)], show);

export default router;
