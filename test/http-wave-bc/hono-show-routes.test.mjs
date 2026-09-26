import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHonoShowRoutes } from '../../adapters/http-wave-bc/node-hono/show-routes-parser.mjs';

test('Hono showRoutes parser preserves registered route order and duplicates', () => {
  const snapshot = parseHonoShowRoutes([
    'GET   /v1/posts',
    'GET   /v1/posts/:id',
    'POST  /v1/posts',
    'GET   /v1/posts',
  ].join('\n'));

  assert.deepEqual(snapshot.routes.map((x) => [x.method, x.path, x.handlers]), [
    ['GET', '/v1/posts', []],
    ['GET', '/v1/posts/:id', []],
    ['POST', '/v1/posts', []],
    ['GET', '/v1/posts', []],
  ]);
  assert.deepEqual(snapshot.unknownLines, []);
});

test('Hono showRoutes parser strips ANSI and reports non-route lines instead of guessing', () => {
  const snapshot = parseHonoShowRoutes([
    '\u001b[32mGET\u001b[0m   /health',
    'router: RegExpRouter',
    'ALL   /api/* verbose-metadata',
  ].join('\n'));

  assert.deepEqual(snapshot.routes.map((x) => [x.method, x.path]), [
    ['GET', '/health'],
    ['ALL', '/api/*'],
  ]);
  assert.deepEqual(snapshot.unknownLines, [{ line: 2, text: 'router: RegExpRouter' }]);
});


test('Hono showRoutes parser binds official verbose handler lines to the preceding route', () => {
  const snapshot = parseHonoShowRoutes([
    '\u001b[32mALL\u001b[0m      /*',
    '           [middleware]',
    '\u001b[32mGET\u001b[0m      /named',
    '           namedMiddleware',
    '           namedHandler',
    '\u001b[32mPOST\u001b[0m     /',
    '           [handler]',
  ].join('\n'));

  assert.deepEqual(snapshot.routes.map((route) => ({
    method: route.method,
    path: route.path,
    handlers: route.handlers.map((handler) => handler.name),
  })), [
    { method: 'ALL', path: '/*', handlers: ['[middleware]'] },
    { method: 'GET', path: '/named', handlers: ['namedMiddleware', 'namedHandler'] },
    { method: 'POST', path: '/', handlers: ['[handler]'] },
  ]);
  assert.deepEqual(snapshot.unknownLines, []);
});
