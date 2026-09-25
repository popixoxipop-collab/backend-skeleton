import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter, detectHonoRoot, scanHono } from '../../adapters/http-wave-bc/node-hono/adapter.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-hono-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

test('T13 Hono descriptor is conservative until OpenAPI/runtime evidence exists', () => {
  assert.equal(adapter.contract, 'sbf.adapter/2');
  assert.equal(adapter.id, 'node-hono');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});

test('detect requires dependency plus live Hono source, not a comment', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '^4.0.0' } }),
    'src/comment.ts': "// import { Hono } from 'hono'\n// const app = new Hono()\n",
  });
  try { assert.equal(detectHonoRoot(root), null); }
  finally { cleanup(root); }
});

test('scan emits literal routes and applies a literal chained basePath', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '^4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      "const api = new Hono().basePath('/api')",
      "api.get('/users', listUsers)",
      "api.post('/users', createUser)",
      "// api.delete('/ghost', removeGhost)",
      "const dynamic = '/runtime'",
      "api.get(dynamic, runtimeHandler)",
    ].join('\n'),
  });
  try {
    const detection = detectHonoRoot(root);
    assert.ok(detection);
    const report = scanHono(root, detection);
    assert.equal(report.modules.length, 1);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path, x.operationId, x.method]), [
      ['GET', '/api/users', null, 'listUsers'],
      ['POST', '/api/users', null, 'createUser'],
    ]);
    assert.equal(report.modules[0].controllers[0].basePath, '/api/users');
    assert.ok(report.scanNotes[0].includes('only literal routes'));
  } finally { cleanup(root); }
});

test('scan records route() mounts as unknown instead of inventing nested endpoints', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      'const app = new Hono()',
      "app.route('/api', users)",
      "app.get('/health', health)",
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    assert.equal(report.modules[0].controllers[0].endpoints[0].path, '/health');
    assert.ok(report.scanNotes.some((x) => x.includes('route() mount') && x.includes('/api')));
  } finally { cleanup(root); }
});

test('regex literals cannot unmask commented-out Hono routes', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      'const app = new Hono()',
      "const quoteMatcher = /'/g; // app.get('/ghost', ghost)",
      "app.get('/live', live)",
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => x.path), ['/live']);
  } finally { cleanup(root); }
});

test('dynamic basePath and interpolated template routes are refused instead of mis-normalized', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      "const dynamicBase = '/api'",
      'const app = new Hono().basePath(dynamicBase)',
      "app.get('/users', users)",
      'const plain = new Hono()',
      "plain.get(`/users/${id}`, userById)",
      "plain.get('/health', health)",
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    const endpoints = report.modules.flatMap((m) => m.controllers).flatMap((c) => c.endpoints);
    assert.deepEqual(endpoints.map((x) => x.path), ['/health']);
    assert.ok(report.scanNotes.some((x) => x.includes('basePath()') && x.includes('non-literal')));
    assert.ok(report.scanNotes.some((x) => x.includes('interpolated template route')));
  } finally { cleanup(root); }
});

test('all/on/use/mount are recorded as unsupported first-slice semantics', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      'const app = new Hono()',
      "app.all('/all', allHandler)",
      "app.on('GET', '/on', onHandler)",
      "app.use('/api/*', middleware)",
      "app.mount('/external', externalHandler)",
      "app.get('/health', health)",
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => x.path), ['/health']);
    for (const method of ['all', 'on', 'use', 'mount']) {
      assert.ok(report.scanNotes.some((x) => x.includes(`Hono ${method}()`)), `missing note for ${method}()`);
    }
  } finally { cleanup(root); }
});

test('listReadSet is deterministic and includes package + source inputs', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/z.ts': "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/z', z)",
    'src/a.ts': "export const a = 1",
  });
  try {
    const first = adapter.listReadSet(root);
    const second = adapter.listReadSet(root);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
    assert.ok(first.includes('package.json'));
    assert.ok(first.includes(path.join('src', 'z.ts')));
  } finally { cleanup(root); }
});
