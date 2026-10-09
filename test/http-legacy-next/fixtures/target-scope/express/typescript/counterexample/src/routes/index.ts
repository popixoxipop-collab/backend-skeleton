import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { handler } from '../controllers';

const router = Router();

router.get('/open', handler);
router.use(requireAuth); // router-wide auth middleware: everything below needs the token
router.get('/secret', handler);
for (const name of ['alpha', 'beta']) {
  router.get(`/gen/${name}`, handler); // paths generated in a loop
}
router.route('/chain').get(handler).post(handler);
router.all('/any', handler);
router.get(['/a1', '/a2'], handler);
router.get('/inline', (_req, res) => {
  res.status(200).json({ ok: true });
});

export default router;
