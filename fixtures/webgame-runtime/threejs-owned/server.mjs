import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const port = Number(process.argv[2] ?? 41738);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
const allowed = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/vendor/three.module.js', ['vendor/three.module.js', 'text/javascript; charset=utf-8']],
]);
const server = http.createServer((request, response) => {
  const entry = allowed.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!entry) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
  response.end(fs.readFileSync(path.join(dist, ...entry[0].split('/'))));
});
server.listen(port, '127.0.0.1');
