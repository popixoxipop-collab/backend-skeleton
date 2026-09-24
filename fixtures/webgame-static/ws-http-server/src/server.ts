import { WebSocket } from 'ws';
import http from 'node:http';
const server = new http.Server();
const client = new WebSocket('ws://example.invalid');
