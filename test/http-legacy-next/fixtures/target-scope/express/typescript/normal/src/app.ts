import express from 'express';
import routes from './routes';

const app = express();
app.use('/api', routes); // application-level prefix over an imported router

export default app;
