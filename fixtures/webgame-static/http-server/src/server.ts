import http from 'node:http';
const server = http.createServer((_req, res) => res.end('ok'));
