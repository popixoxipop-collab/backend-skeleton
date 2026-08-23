// The mount-tree root. Two things here are deliberately NOT what the typescript-express fixture
// does, because they are what a real plain-JS Express app does:
//   1. the Router variable is named `route`, not `router`
//   2. the global `/api` prefix lives on an intra-file `app.use('/api', route)` edge -- from the
//      express() APPLICATION to a locally-declared Router, with no import involved at all
import express from 'express';
import cors from 'cors';
import userRoute from './routes/user.route.js';
import orderRoute from './routes/order.route.js';

const app = express();
const route = express.Router();

app.use(cors());
app.use(express.json());

route.use('/user', userRoute);
route.use('/order', orderRoute);

app.use('/api', route);

export default app;
