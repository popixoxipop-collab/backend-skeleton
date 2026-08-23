// `express.Router()` via the default import -- the dominant plain-JS idiom, and one the
// typescript-express adapter's `import { Router } from 'express'` detection would never see.
// The middleware array nests parens exactly the way the TS oracle's did
// (`requireRole(['admin'], true)`), so balanced-paren argument splitting is load-bearing here too.
import express from 'express';
import { verifyToken } from '../middleware/verifyToken.js';
import { requireRole } from '../middleware/requireRole.js';
import { getUser, listUsers, updateUser } from '../controllers/user.controller.js';

const router = express.Router();

router.get('/list', [verifyToken, requireRole(['admin'], true)], listUsers);
router.get('/:userUid', verifyToken, getUser);
router.patch('/:userUid', verifyToken, updateUser);

export default router;
