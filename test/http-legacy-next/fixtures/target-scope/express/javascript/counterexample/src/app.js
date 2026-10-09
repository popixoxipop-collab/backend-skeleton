import express from 'express';
import routes from './routes/index.js';
import apiRouter from './routes/api.js';
import ping from './routes/ping.js';
import { legacyRouter } from './routes/legacy.js';
import { crud } from './routes/factory.js';

const app = express();
const base = process.env.API_BASE ?? '/svc';

app.use('/api', apiRouter); // app-level mount prefix over an imported router
app.use('/legacy', legacyRouter); // router handed over under an alias (export { router as legacyRouter })
app.use(base, ping); // mount path decided at start-up by the environment
app.use('/widgets', crud('widgets')); // mounted router built by a function call
app.use(routes); // router-wide auth middleware inside: mounted last, guards only what is left over

export default app;
