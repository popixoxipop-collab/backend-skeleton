import express from 'express';
import { WebSocketServer } from 'ws';
const app = express();
app.get('/health', (_req, res) => res.send('ok'));
const sockets = new WebSocketServer({ noServer: true });
