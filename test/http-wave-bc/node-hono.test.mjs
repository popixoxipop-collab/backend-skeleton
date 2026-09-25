import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
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

test('T13 Hono descriptor conforms to the current sbf.adapter/2 JSON schema', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../../schemas/adapter.schema.json'), 'utf8'));
  const { detect, scan, diagnostics, listReadSet, introspectRoutes, ...data } = adapter;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
});

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

test('frozen Hono official README reference shape is detected at the pinned upstream version', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../fixtures/http-wave-bc/hono-official-readme');
  const detection = detectHonoRoot(root);
  assert.ok(detection);
  const report = scanHono(root, detection);
  assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => [x.verb, x.path]), [
    ['GET', '/'],
  ]);
});

test('detect requires dependency plus live Hono source, not a comment', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '^4.0.0' } }),
    'src/comment.ts': "// import { Hono } from 'hono'\n// const app = new Hono()\n",
  });
  try { assert.equal(detectHonoRoot(root), null); }
  finally { cleanup(root); }
});

test('generic-typed Hono constructors are detected and scanned', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      'type Bindings = { TOKEN: string }',
      'const app = new Hono<{ Bindings: Bindings }>()',
      "app.get('/health', health)",
      'export default app',
    ].join('\n'),
  });
  try {
    assert.ok(detectHonoRoot(root));
    const report = scanHono(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => x.path), ['/health']);
  } finally { cleanup(root); }
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
    assert.ok(report.scanNotes[0].includes('Hono route graph'));
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


test('same-file route() mount snapshots only child routes registered before the mount', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      'const child = new Hono()',
      "child.get('/before', before)",
      "const app = new Hono().basePath('/v1')",
      "app.route('/api', child)",
      "child.get('/after', after)",
      "app.get('/root', rootHandler)",
      'export default app',
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    assert.equal(report.modules.length, 1);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path]), [
      ['GET', '/v1/api/before'],
      ['GET', '/v1/root'],
    ]);
    assert.ok(!endpoints.some((x) => x.path.includes('/after')));
  } finally { cleanup(root); }
});

test('relative default-imported Hono sub-app is resolved through route() with child basePath', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/users.ts': [
      "import { Hono } from 'hono'",
      "const users = new Hono().basePath('/users')",
      "users.get('/:id', getUser)",
      'export default users',
    ].join('\n'),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      "import users from './users'",
      'const app = new Hono()',
      "app.route('/api', users)",
      'export default app',
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    assert.equal(report.modules.length, 1);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => x.path), ['/api/users/:id']);
  } finally { cleanup(root); }
});

test('relative named import alias resolves a Hono sub-app without name guessing', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { hono: '4.0.0' } }),
    'src/admin.ts': [
      "import { Hono } from 'hono'",
      'export const admin = new Hono()',
      "admin.get('/status', status)",
    ].join('\n'),
    'src/app.ts': [
      "import { Hono } from 'hono'",
      "import { admin as adminApp } from './admin'",
      'const app = new Hono()',
      "app.route('/v2', adminApp)",
      'export default app',
    ].join('\n'),
  });
  try {
    const report = scanHono(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => x.path), ['/v2/status']);
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
