import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  adapter,
  detectNextServerRoutesRoot,
  scanNextServerRoutes,
} from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

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

function pkg() {
  return JSON.stringify({ name: 'next-demo', dependencies: { next: '16.0.0' } });
}

function endpoints(report) {
  return report.modules.flatMap((module) => module.controllers).flatMap((controller) => controller.endpoints);
}

test('T13 Next descriptor conforms to current sbf.adapter/2 and remains conservative', () => {
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

test('detection requires a next dependency plus an App route or Pages API file', () => {
  const uiOnly = fixture({
    'package.json': pkg(),
    'app/page.tsx': 'export default function Page() { return null }',
  });
  try {
    assert.equal(detectNextServerRoutesRoot(uiOnly), null);
  } finally {
    cleanup(uiOnly);
  }

  const noDependency = fixture({
    'package.json': JSON.stringify({ name: 'demo' }),
    'app/api/route.ts': 'export function GET() {}',
  });
  try {
    assert.equal(detectNextServerRoutesRoot(noDependency), null);
  } finally {
    cleanup(noDependency);
  }
});

test('string literals cannot impersonate App method exports, Pages default exports, or next.config basePath', () => {
  const appFake = fixture({
    'package.json': pkg(),
    'app/api/route.ts': `const example = "export function GET() {}"`,
  });
  try {
    const report = scanNextServerRoutes(appFake);
    assert.deepEqual(report.modules, []);
  } finally {
    cleanup(appFake);
  }

  const pagesFake = fixture({
    'package.json': pkg(),
    'pages/api/hello.ts': `const example = "export default function handler() {}"`,
  });
  try {
    const report = scanNextServerRoutes(pagesFake);
    assert.deepEqual(report.modules, []);
  } finally {
    cleanup(pagesFake);
  }

  const configFake = fixture({
    'package.json': pkg(),
    'next.config.js': `export default { note: "basePath: '/fake'" }`,
    'app/api/route.ts': 'export function GET() {}',
  });
  try {
    const report = scanNextServerRoutes(configFake);
    assert.deepEqual(endpoints(report).map((endpoint) => endpoint.path), ['/api']);
  } finally {
    cleanup(configFake);
  }
});

test('App Router route.ts exposes directly-declared method exports with source lines', () => {
  const root = fixture({
    'package.json': pkg(),
    'app/api/users/route.ts': [
      'const helper = 1',
      'export async function GET() { return Response.json([]) }',
      'export const POST = async () => Response.json({ ok: true })',
    ].join('\n'),
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => [
      endpoint.verb,
      endpoint.path,
      endpoint.method,
      endpoint.line,
    ]), [
      ['GET', '/api/users', 'GET', 2],
      ['POST', '/api/users', 'POST', 3],
    ]);
  } finally {
    cleanup(root);
  }
});

test('App Router route groups disappear from URL and simple dynamic segments become contract parameters', () => {
  const root = fixture({
    'package.json': pkg(),
    'app/(internal)/users/[id]/route.ts': 'export function GET() {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => endpoint.path), ['/users/{id}']);
  } finally {
    cleanup(root);
  }
});

test('App Router method re-exports are not treated as local method evidence', () => {
  const root = fixture({
    'package.json': pkg(),
    'app/api/route.ts': "export { GET } from './handlers'",
    'app/api/handlers.ts': 'export function GET() {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((note) => note.includes('method re-export')));
    assert.ok(report.scanNotes.some((note) => note.includes('no directly-declared supported HTTP method')));
  } finally {
    cleanup(root);
  }
});

test('Pages Router API path is filesystem-derived while HTTP method stays unknown', () => {
  const root = fixture({
    'package.json': pkg(),
    'pages/api/hello.ts': [
      'const value = 1',
      'export default function handler(req, res) {',
      '  res.status(200).json({ value })',
      '}',
    ].join('\n'),
  });
  try {
    const report = scanNextServerRoutes(root);
    const endpoint = endpoints(report)[0];
    assert.deepEqual([endpoint.verb, endpoint.path, endpoint.method, endpoint.line], ['?', '/api/hello', null, 2]);
  } finally {
    cleanup(root);
  }
});

test('Pages Router supports index and simple dynamic filesystem segments without inferring methods', () => {
  const root = fixture({
    'package.json': pkg(),
    'src/pages/api/index.ts': 'export default function root(req, res) {}',
    'src/pages/api/users/[id].ts': 'export default function byId(req, res) {}',
    'src/pages/api/types.d.ts': 'export interface Types {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => [endpoint.verb, endpoint.path]).sort(), [
      ['?', '/api'],
      ['?', '/api/users/{id}'],
    ]);
  } finally {
    cleanup(root);
  }
});

test('literal next.config basePath prefixes both App and Pages API routes', () => {
  const root = fixture({
    'package.json': pkg(),
    'next.config.js': "export default { basePath: '/docs' }",
    'app/api/route.ts': 'export function GET() {}',
    'pages/api/hello.ts': 'export default function handler(req, res) {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => endpoint.path).sort(), [
      '/docs/api',
      '/docs/api/hello',
    ]);
  } finally {
    cleanup(root);
  }
});

test('dynamic next.config basePath withholds absolute server route paths', () => {
  const root = fixture({
    'package.json': pkg(),
    'next.config.js': "const prefix = process.env.BASE_PATH; export default { basePath: prefix }",
    'app/api/route.ts': 'export function GET() {}',
    'pages/api/hello.ts': 'export default function handler(req, res) {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(report.modules, []);
    assert.ok(report.scanNotes.some((note) => note.includes('basePath is non-literal')));
  } finally {
    cleanup(root);
  }
});

test('catch-all, intercepting, parallel and private segments are withheld rather than normalized incorrectly', () => {
  const root = fixture({
    'package.json': pkg(),
    'app/api/[...slug]/route.ts': 'export function GET() {}',
    'app/(.)shadow/route.ts': 'export function GET() {}',
    'app/@slot/api/route.ts': 'export function GET() {}',
    'app/_private/api/route.ts': 'export function GET() {}',
    'app/health/route.ts': 'export function GET() {}',
    'pages/api/[...slug].ts': 'export default function handler(req, res) {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => endpoint.path), ['/health']);
    assert.ok(report.scanNotes.some((note) => note.includes('catch-all segment')));
    assert.ok(report.scanNotes.some((note) => note.includes('intercepting/parallel')));
    assert.ok(report.scanNotes.some((note) => note.includes('private route segment')));
  } finally {
    cleanup(root);
  }
});

test('rewrites are reported as unresolved aliases without hiding canonical filesystem routes', () => {
  const root = fixture({
    'package.json': pkg(),
    'next.config.js': [
      'export default {',
      '  async rewrites() { return [{ source: "/legacy", destination: "/api/hello" }] },',
      '}',
    ].join('\n'),
    'pages/api/hello.ts': 'export default function handler(req, res) {}',
  });
  try {
    const report = scanNextServerRoutes(root);
    assert.deepEqual(endpoints(report).map((endpoint) => endpoint.path), ['/api/hello']);
    assert.ok(report.scanNotes.some((note) => note.includes('rewrites are present')));
  } finally {
    cleanup(root);
  }
});

test('read-set is deterministic and includes package, config and route files', () => {
  const root = fixture({
    'package.json': pkg(),
    'next.config.js': "export default { basePath: '/docs' }",
    'app/api/route.ts': 'export function GET() {}',
  });
  try {
    const first = adapter.listReadSet(root);
    const second = adapter.listReadSet(root);
    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort());
    assert.ok(first.includes('package.json'));
    assert.ok(first.includes('next.config.js'));
    assert.ok(first.includes(path.join('app', 'api', 'route.ts')));
  } finally {
    cleanup(root);
  }
});
