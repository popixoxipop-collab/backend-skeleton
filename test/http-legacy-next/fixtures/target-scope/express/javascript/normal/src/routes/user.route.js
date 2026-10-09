import express from 'express';
import { verifyToken, requireRole } from '../middleware/verifyToken.js';
import { listUsers, getUser, updateUser } from '../controllers/handlers.js';

const router = express.Router();

router.get('/list', [verifyToken, requireRole(['admin'], true)], listUsers);
router.get('/:userUid', verifyToken, getUser);
router.patch('/:userUid', verifyToken, updateUser);
// Retired: router.delete('/:userUid', verifyToken, updateUser);

export default router;
