import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adapter,
  detectNodeFastifyRoot,
  scanNodeFastify,
} from '../scanners/adapters/node-fastify.mjs';

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ fastify = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-fastify-'));
  write(root, 'package.json', JSON.stringify({
    name: 'fixture',
    dependencies: fastify ? { fastify: '^5.0.0' } : { express: '^5.0.0' }
  }, null, 2));

  write(root, 'src/app.ts', [
    "import Fastify from 'fastify';",
    "import users from './users.js';",
    "const app = Fastify({ logger: true });",
    "app.get('/health', async () => ({ ok: true }));",
    "app.register(users, { prefix: '/v1' });",
    "app.register(require('./admin'), { prefix: '/admin' });",
    ''
  ].join('\n'));

  write(root, 'src/users.ts', [
    "import type { FastifyPluginAsync } from 'fastify';",
    "import details from './details';",
    "const users: FastifyPluginAsync = async (fastify) => {",
    "  fastify.get('/users/:id', showUser);",
    "  fastify.route({ method: 'POST', url: '/users', handler: createUser });",
    "  fastify.get(dynamicPath, ignoredDynamicPath);",
    "  fastify.register(details, { prefix: '/details' });",
    "};",
    "export default users;",
    ''
  ].join('\n'));

  write(root, 'src/details.ts', [
    "import type { FastifyPluginAsync } from 'fastify';",
    "const details: FastifyPluginAsync = async (server) => {",
    "  server.get('/:id', getDetail);",
    "};",
    "export default details;",
    ''
  ].join('\n'));

  write(root, 'src/admin.js', [
    "const Fastify = require('fastify');",
    "module.exports = async function (server) {",
    "  server.delete('/users/:id', removeUser);",
    "};",
    ''
  ].join('\n'));
  return root;
}

test('detectNodeFastifyRoot requires a fastify dependency plus source-confirmed Fastify use', () => {
  const root = fixture();
  assert.equal(detectNodeFastifyRoot(root), root);
  const other = fixture({ fastify: false });
  assert.equal(detectNodeFastifyRoot(other), null);
});

test('scanNodeFastify extracts shorthand and route-object endpoints without inventing operation IDs', () => {
  const root = fixture();
  const report = scanNodeFastify(root, root);

  const app = report.modules.find((m) => m.module === 'app');
  assert.ok(app);
  assert.deepEqual(
    app.controllers[0].endpoints.map((e) => [e.verb, e.path, e.operationId]),
    [['GET', '/health', null]]
  );

  const users = report.modules.find((m) => m.module === 'users');
  assert.ok(users);
  assert.equal(users.controllers[0].basePath, '/v1');
  assert.deepEqual(
    users.controllers[0].endpoints.map((e) => [e.verb, e.path, e.method]),
    [
      ['GET', '/v1/users/:id', 'showUser'],
      ['POST', '/v1/users', 'createUser'],
    ]
  );
});

test('relative register edges compose nested literal prefixes, including inline require()', () => {
  const root = fixture();
  const report = scanNodeFastify(root, root);

  const details = report.modules.find((m) => m.module === 'details');
  assert.ok(details);
  assert.equal(details.controllers[0].basePath, '/v1/details');
  assert.equal(details.controllers[0].endpoints[0].path, '/v1/details/:id');

  const admin = report.modules.find((m) => m.module === 'admin');
  assert.ok(admin);
  assert.equal(admin.controllers[0].basePath, '/admin');
  assert.equal(admin.controllers[0].endpoints[0].path, '/admin/users/:id');
});

test('computed route paths are skipped instead of guessed', () => {
  const root = fixture();
  const report = scanNodeFastify(root, root);
  const allEndpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
  assert.equal(allEndpoints.some((e) => e.method === 'ignoredDynamicPath'), false);
});

test('listReadSet contains package.json and every source file used by detection/scan', () => {
  const root = fixture();
  assert.deepEqual(adapter.listReadSet(root), [
    'package.json',
    path.join('src', 'admin.js'),
    path.join('src', 'app.ts'),
    path.join('src', 'details.ts'),
    path.join('src', 'users.ts'),
  ]);
});

test('first Fastify slice keeps schema, persistence and codegen capabilities off', () => {
  assert.equal(adapter.id, 'node-fastify');
  assert.equal(adapter.contract, 'sbf.adapter/2');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});
