import { Router } from 'express';
import users from './users';
import orders from './orders';

const router = Router();
router.use('/users', users);
router.use('/orders', orders);

export default router;
