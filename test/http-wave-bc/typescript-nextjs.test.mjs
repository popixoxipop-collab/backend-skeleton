import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { adapter, detectNextRoot, scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-next-'));
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

test('T13 Next.js descriptor conforms to current sbf.adapter/2 and stays conservative', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(fs.readFileSync(path.resolve(here, '../../schemas/adapter.schema.json'), 'utf8'));
  const { detect, scan, diagnostics, listReadSet, introspectRoutes, ...data } = adapter;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
  assert.equal(adapter.id, 'typescript-nextjs');
  assert.equal(adapter.verificationBasis, 'synthetic-only');
  assert.deepEqual(adapter.capabilities, {
    'api.operations': false,
    'api.request-shape': false,
    'resource.fetch': false,
    'codegen.handles': false,
  });
});

test('frozen official Next.js Route Handler fixture emits only the explicit GET route', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, './fixtures/nextjs-official-route-handler');
  const detection = detectNextRoot(root);
  assert.ok(detection);
  const report = scanNext(root, detection);
  const endpoints = report.modules[0].controllers[0].endpoints;
  assert.deepEqual(endpoints.map((x) => [x.verb, x.path, x.operationId]), [
    ['GET', '/api', null],
  ]);
  assert.ok(!endpoints.some((x) => x.verb === 'OPTIONS'));
  assert.ok(report.scanNotes.some((x) => x.includes('framework-generated OPTIONS')));
});

test('route groups disappear from URL while simple dynamic segments become path parameters', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'app/(admin)/api/users/[id]/route.ts': [
      'export async function GET() {}',
      'export const PATCH = async () => new Response()',
    ].join('\n'),
  });
  try {
    const report = scanNext(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path, x.params]), [
      ['GET', '/api/users/{id}', ['id']],
      ['PATCH', '/api/users/{id}', ['id']],
    ]);
  } finally {
    cleanup(root);
  }
});

test('catch-all and optional catch-all Route Handlers are not flattened into fake single params', () => {
  for (const segment of ['[...slug]', '[[...slug]]']) {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
      [`app/shop/${segment}/route.ts`]: 'export async function GET() {}',
    });
    try {
      assert.ok(detectNextRoot(root));
      const report = scanNext(root);
      assert.deepEqual(report.modules, []);
      assert.ok(report.scanNotes.some((x) => x.includes('catch-all-segment')));
    } finally {
      cleanup(root);
    }
  }
});

test('literal next.config basePath is applied to App Route paths', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'next.config.js': "module.exports = { basePath: '/docs' }\n",
    'app/api/users/route.js': [
      'export function GET() {}',
      'export function POST() {}',
    ].join('\n'),
  });
  try {
    const endpoints = scanNext(root).modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path]), [
      ['GET', '/docs/api/users'],
      ['POST', '/docs/api/users'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('dynamic next.config basePath withholds endpoint paths instead of guessing', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'next.config.js': "module.exports = { basePath: process.env.BASE_PATH }\n",
    'app/api/route.js': 'export function GET() {}',
  });
  try {
    const report = scanNext(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((x) => x.includes('basePath is present but not a simple literal')));
    assert.ok(report.scanNotes.some((x) => x.includes('withheld because basePath is unresolved')));
  } finally {
    cleanup(root);
  }
});

test('local export alias can supply an HTTP method while external re-export stays unknown', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'app/api/local/route.ts': [
      'const handler = async () => new Response()',
      'export { handler as POST }',
    ].join('\n'),
    'app/api/external/route.ts': "export { handler as GET } from './handler'\n",
  });
  try {
    const report = scanNext(root);
    const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path, x.method]), [
      ['POST', '/api/local', 'handler'],
    ]);
    assert.ok(report.scanNotes.some((x) => x.includes('external re-export for GET')));
  } finally {
    cleanup(root);
  }
});

test('Pages API project is detected but no HTTP method is synthesized from handler control flow', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'pages/api/users.ts': [
      'export default function handler(req, res) {',
      "  if (req.method === 'POST') res.status(201).json({ ok: true })",
      '}',
    ].join('\n'),
  });
  try {
    assert.ok(detectNextRoot(root));
    const report = scanNext(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((x) => x.includes('Pages API files were detected')));
  } finally {
    cleanup(root);
  }
});

test('route-group collisions preserve both source routes and report duplicate HTTP identity', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'app/(one)/health/route.ts': 'export function GET() {}',
    'app/(two)/health/route.ts': 'export function GET() {}',
  });
  try {
    const report = scanNext(root);
    const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
    assert.deepEqual(endpoints.map((x) => [x.verb, x.path]), [
      ['GET', '/health'],
      ['GET', '/health'],
    ]);
    assert.ok(report.scanNotes.some((x) => x.includes('duplicate Route Handler identity GET /health')));
  } finally {
    cleanup(root);
  }
});

test('parallel/intercepting/private route segments are not emitted as ordinary URLs', () => {
  const cases = [
    ['app/@slot/api/route.ts', 'parallel-route-segment'],
    ['app/(.)photo/route.ts', 'intercepting-or-unsupported-segment'],
    ['app/_private/api/route.ts', 'private-folder'],
  ];
  for (const [routeFile, reason] of cases) {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
      [routeFile]: 'export function GET() {}',
    });
    try {
      const report = scanNext(root);
      assert.deepEqual(report.modules, []);
      assert.ok(report.scanNotes.some((x) => x.includes(reason)), routeFile);
    } finally {
      cleanup(root);
    }
  }
});

test('regex literals cannot unmask commented-out Next.js method exports', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'app/api/route.ts': [
      "const quoteMatcher = /'/g; // export function POST() {}",
      'export function GET() {}',
    ].join('\n'),
  });
  try {
    const report = scanNext(root);
    const endpoints = report.modules[0].controllers[0].endpoints;
    assert.deepEqual(endpoints.map((x) => x.verb), ['GET']);
  } finally {
    cleanup(root);
  }
});

test('root app takes precedence over src/app exactly as documented by Next.js', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'app/root/route.ts': 'export function GET() {}',
    'src/app/ignored/route.ts': 'export function GET() {}',
  });
  try {
    const report = scanNext(root);
    const endpoints = report.modules[0].controllers.flatMap((c) => c.endpoints);
    assert.deepEqual(endpoints.map((x) => x.path), ['/root']);
    assert.ok(report.scanNotes.some((x) => x.includes('src/app') && x.includes('ignored')));
    assert.ok(!report.filesRead.some((x) => x.includes(path.join('src', 'app', 'ignored'))));
  } finally {
    cleanup(root);
  }
});

test('src/app is scanned when no root app directory exists', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'src/app/api/route.ts': 'export function GET() {}',
  });
  try {
    const report = scanNext(root);
    assert.deepEqual(report.modules[0].controllers[0].endpoints.map((x) => x.path), ['/api']);
  } finally {
    cleanup(root);
  }
});

test('Next.js read set is deterministic and includes package, route, Pages API and config inputs', () => {
  const root = fixture({
    'package.json': JSON.stringify({ name: 'demo', dependencies: { next: '16.4.0-canary.45' } }),
    'next.config.mjs': "export default { basePath: '/docs' }\n",
    'app/api/route.ts': 'export function GET() {}',
    'pages/api/legacy.ts': 'export default function handler(req, res) {}',
  });
  try {
    const first = adapter.listReadSet(root);
    const second = adapter.listReadSet(root);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
    assert.ok(first.includes('package.json'));
    assert.ok(first.includes('next.config.mjs'));
    assert.ok(first.includes(path.join('app', 'api', 'route.ts')));
    assert.ok(first.includes(path.join('pages', 'api', 'legacy.ts')));
  } finally {
    cleanup(root);
  }
});
