import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { adapter, detectKoaRouterRoot, scanKoaRouter } from '../../adapters/http-wave-bc/node-koa/adapter.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-koa-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('T13 Koa descriptor conforms to current sbf.adapter/2 and stays conservative', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../../schemas/adapter.schema.json'), 'utf8'));
  const { detect, scan, diagnostics, listReadSet, introspectRoutes, ...data } = adapter;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
  assert.equal(adapter.id, 'node-koa');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});

test('frozen official @koa/router README Quick Start is detected at pinned upstream version', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../fixtures/http-wave-bc/koa-router-official-readme');
  const detection = detectKoaRouterRoot(root);
  assert.ok(detection);
  const report = scanKoaRouter(root, detection);
  const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
  assert.deepEqual(endpoints.map((x) => [x.verb, x.path]), [
    ['GET', '/'],
    ['GET', '/users/:id'],
  ]);
});

test('detection requires @koa/router dependency plus a live Router instance, not comments', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0', koa: '3.2.1' } }),
    'src/comment.js': "// import Router from '@koa/router'\n// const router = new Router()\n",
  });
  try {
    assert.equal(detectKoaRouterRoot(root), null);
  } finally {
    cleanup(root);
  }
});

test('literal constructor prefix, named route and del alias are emitted without inventing operationId', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.ts': [
      "import Router from '@koa/router'",
      "const router = new Router({ prefix: '/api' })",
      "router.get('user', '/users/:id', showUser)",
      "router.del('/users/:id', deleteUser)",
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path, x.operationId, x.routeName, x.method]), [
      ['GET', '/api/users/:id', null, 'user', 'showUser'],
      ['DELETE', '/api/users/:id', null, null, 'deleteUser'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('generic Router constructor and named import alias are recognized', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.ts': [
      "import { Router as KoaRouter } from '@koa/router'",
      'type State = { user?: string }',
      'type Context = { requestId: string }',
      'const router = new KoaRouter<State, Context>()',
      "router.patch('/users/:id', patchUser)",
    ].join('\n'),
  });
  try {
    assert.ok(detectKoaRouterRoot(root));
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => [x.verb, x.path]), [
      ['PATCH', '/users/:id'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('CommonJS Router binding is recognized', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.cjs': [
      "const Router = require('@koa/router')",
      'const router = new Router()',
      "router.post('/jobs', createJob)",
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => x.path), ['/jobs']);
  } finally {
    cleanup(root);
  }
});

test('prefix() mutation causes route emission to fail closed instead of publishing stale paths', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.js': [
      "import Router from '@koa/router'",
      'const router = new Router()',
      "router.get('/before', before)",
      "router.prefix('/api')",
      "router.get('/after', after)",
    ].join('\n'),
  });
  try {
    assert.ok(detectKoaRouterRoot(root));
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((x) => x.includes('prefix() mutation') && x.includes('not emitted')));
  } finally {
    cleanup(root);
  }
});

test('dynamic route remains unknown but the Koa router profile is still detected', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.js': [
      "import Router from '@koa/router'",
      'const router = new Router()',
      "const pathName = '/runtime'",
      'router.get(pathName, runtimeHandler)',
    ].join('\n'),
  });
  try {
    assert.ok(detectKoaRouterRoot(root));
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((x) => x.includes('dynamic/non-literal')));
  } finally {
    cleanup(root);
  }
});

test('all() and use() are reported as unexpanded semantics while direct literal routes survive', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.js': [
      "import Router from '@koa/router'",
      'const router = new Router()',
      "router.all('/any', anyHandler)",
      "router.use('/users', usersRouter.routes())",
      "router.get('/health', health)",
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => x.path), ['/health']);
    assert.ok(report.scanNotes.some((x) => x.includes('all()')));
    assert.ok(report.scanNotes.some((x) => x.includes('use()')));
  } finally {
    cleanup(root);
  }
});

test('regex literals cannot unmask commented-out Koa routes', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/router.js': [
      "import Router from '@koa/router'",
      'const router = new Router()',
      "const quoteMatcher = /'/g; // router.get('/ghost', ghost)",
      "router.get('/live', live)",
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => x.path), ['/live']);
  } finally {
    cleanup(root);
  }
});

test('Koa read set is deterministic and includes package plus source inputs', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { '@koa/router': '15.7.0' } }),
    'src/z.js': "import Router from '@koa/router'\nconst r = new Router()\nr.get('/z', z)",
    'src/a.js': 'export const a = 1',
  });
  try {
    const first = adapter.listReadSet(root);
    const second = adapter.listReadSet(root);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
    assert.ok(first.includes('package.json'));
    assert.ok(first.includes(path.join('src', 'z.js')));
  } finally {
    cleanup(root);
  }
});
