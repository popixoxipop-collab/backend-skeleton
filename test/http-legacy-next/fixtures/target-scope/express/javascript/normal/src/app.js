import express from 'express';
import userRoute from './routes/user.route.js';
import orderRoute from './routes/order.route.js';

const app = express();
const route = express.Router();

route.get('/ping', (_req, res) => {
  res.status(200).json({ ok: true });
});
route.use('/user', userRoute);
route.use('/order', orderRoute);

app.use('/api', route);

export default app;
