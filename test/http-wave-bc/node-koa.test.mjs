import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  adapter,
  detectKoaRouterRoot,
  scanKoaRouter,
} from '../../adapters/http-wave-bc/node-koa/adapter.mjs';

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

function packageJson(extra = {}) {
  return JSON.stringify({
    name: 'koa-demo',
    dependencies: {
      koa: '3.2.1',
      '@koa/router': '15.7.0',
    },
    ...extra,
  });
}

test('T13 Koa descriptor conforms to current sbf.adapter/2 and remains conservative', () => {
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
  const root = path.resolve(here, './fixtures/koa-router-official-readme');
  const detection = detectKoaRouterRoot(root);
  assert.ok(detection);
  const report = scanKoaRouter(root, detection);
  const endpoints = report.modules[0].controllers.flatMap((controller) => controller.endpoints);
  assert.deepEqual(endpoints.map((endpoint) => [endpoint.verb, endpoint.path]), [
    ['GET', '/'],
    ['GET', '/users/:id'],
  ]);
});

test('detection requires both dependencies plus live Koa and @koa/router constructors', () => {
  const comments = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "// import Koa from 'koa'",
      "// import Router from '@koa/router'",
      '// const app = new Koa()',
      '// const router = new Router()',
    ].join('\n'),
  });
  try {
    assert.equal(detectKoaRouterRoot(comments), null);
  } finally {
    cleanup(comments);
  }

  const missingDependency = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { koa: '3.2.1' } }),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
    ].join('\n'),
  });
  try {
    assert.equal(detectKoaRouterRoot(missingDependency), null);
  } finally {
    cleanup(missingDependency);
  }
});

test('string literals cannot impersonate Koa imports, constructors, or router calls', () => {
  const fakeOnly = fixture({
    'package.json': packageJson(),
    'src/fake.js': [
      `const a = "import Koa from 'koa'"`,
      `const b = "import Router from '@koa/router'"`,
      `const c = "const app = new Koa(); const router = new Router()"`,
    ].join('\n'),
  });
  try {
    assert.equal(detectKoaRouterRoot(fakeOnly), null);
  } finally {
    cleanup(fakeOnly);
  }

  const real = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      `const example = "router.get('/ghost', ghost)"`,
      "router.get('/live', live)",
      'app.use(router.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(real);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((endpoint) => endpoint.path), ['/live']);
  } finally {
    cleanup(real);
  }
});

test('official Quick Start shape, constructor prefix, named route and app wiring emit bounded endpoints', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      "const router = new Router({ prefix: '/api' })",
      "router.get('/users/:id', getUser)",
      "router.post('createUser', '/users', createUser)",
      'app.use(router.routes()).use(router.allowedMethods())',
    ].join('\n'),
  });
  try {
    const detection = detectKoaRouterRoot(root);
    assert.ok(detection);
    const report = scanKoaRouter(root, detection);
    assert.equal(report.modules.length, 1);
    const controller = report.modules[0].controllers[0];
    assert.equal(path.basename(controller.file), 'app.js');
    assert.deepEqual(controller.endpoints.map((endpoint) => [
      endpoint.verb,
      endpoint.path,
      endpoint.routeName,
      endpoint.method,
      endpoint.operationId,
      endpoint.line,
    ]), [
      ['GET', '/api/users/:id', null, 'getUser', null, 5],
      ['POST', '/api/users', 'createUser', 'createUser', null, 6],
    ]);
    assert.equal(controller.basePath, '/api/users');
    assert.ok(controller.file.endsWith(path.join('src', 'app.js')));
  } finally {
    cleanup(root);
  }
});

test('CommonJS aliases and del() map to DELETE when the router is mounted', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.cjs': [
      "const KoaApp = require('koa')",
      "const KoaRouter = require('@koa/router')",
      'const server = new KoaApp()',
      'const routes = new KoaRouter()',
      "routes.del('/users/:id', removeUser)",
      'server.use(routes.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((endpoint) => [endpoint.verb, endpoint.path]), [
      ['DELETE', '/users/:id'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('unmounted router routes are withheld instead of treated as live application routes', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      "router.get('/ghost', ghost)",
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((note) => note.includes('no same-file Koa app mounts router.routes()')));
  } finally {
    cleanup(root);
  }
});

test('router.prefix() mutation withholds the router because it can rewrite existing route paths', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      "router.get('/before', before)",
      "router.prefix('/api')",
      "router.get('/after', after)",
      'app.use(router.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((note) => note.includes('calls prefix()')));
  } finally {
    cleanup(root);
  }
});

test('nested router.use() is reported but direct literal routes remain available', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      'const users = new Router()',
      "users.get('/', listUsers)",
      "router.use('/users', users.routes())",
      "router.get('/health', health)",
      'app.use(router.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((endpoint) => endpoint.path), ['/health']);
    assert.ok(report.scanNotes.some((note) => note.includes('router.use()')));
    assert.ok(!endpoints.some((endpoint) => endpoint.path.includes('/users')));
  } finally {
    cleanup(root);
  }
});

test('dynamic, array and RegExp route paths are not invented', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      "const dynamic = '/dynamic'",
      'router.get(dynamic, dynamicHandler)',
      "router.get(['/a', '/b'], arrayHandler)",
      'router.get(/^\\/regex/, regexHandler)',
      "router.get('/literal', literalHandler)",
      'app.use(router.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((endpoint) => endpoint.path), ['/literal']);
    assert.equal(report.scanNotes.filter((note) => note.includes('not emitted')).length >= 3, true);
  } finally {
    cleanup(root);
  }
});

test('matching-affecting router options such as host fail closed', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/app.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      "const router = new Router({ prefix: '/api', host: 'example.com' })",
      "router.get('/users', users)",
      'app.use(router.routes())',
    ].join('\n'),
  });
  try {
    const report = scanKoaRouter(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((note) => note.includes('host') && note.includes('not modeled')));
  } finally {
    cleanup(root);
  }
});

test('read-set is deterministic and contains package plus source inputs', () => {
  const root = fixture({
    'package.json': packageJson(),
    'src/z.js': [
      "import Koa from 'koa'",
      "import Router from '@koa/router'",
      'const app = new Koa()',
      'const router = new Router()',
      "router.get('/z', z)",
      'app.use(router.routes())',
    ].join('\n'),
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
