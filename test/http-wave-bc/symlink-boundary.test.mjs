// T13-04 bounded filesystem evidence: symlinked inputs must not silently
// synthesize HTTP routes outside the selected repository tree.
// No chmod(000) oracle is used: privileged CI accounts may still read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHonoRoot, scanHono } from '../../adapters/http-wave-bc/node-hono/adapter.mjs';
import { detectKoaRouterRoot, scanKoaRouter } from '../../adapters/http-wave-bc/node-koa/adapter.mjs';
import { detectNextRoot, scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

function stage(t, dependency) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-security-boundary-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo');
  const external = path.join(temporary, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'boundary', dependencies: dependency }));
  return { root, external };
}
function write(base, relative, content) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function assertAbsentResult(detect, scan, root) {
  assert.equal(detect(root), null, 'a symlinked source must not register an adapter');
  const result = scan(root);
  assert.deepEqual(result.modules, [], 'no guessed live routes');
  assert.deepEqual(result.filesRead, [], 'no outside read set');
  assert.ok(result.scanNotes.some((note) => /not detected/i.test(note)), 'non-detection must be explicit');
}
const HONO = "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/escape', handler);\n";
const KOA = "import Koa from 'koa';\nimport Router from '@koa/router';\nconst app = new Koa();\nconst router = new Router();\nrouter.get('/escape', handler);\napp.use(router.routes());\n";

test('Hono does not traverse a symlinked external source directory', (t) => {
  const { root, external } = stage(t, { hono: '4.13.9' });
  write(external, 'app.ts', HONO);
  fs.mkdirSync(path.join(root, 'src'));
  fs.symlinkSync(external, path.join(root, 'src', 'external'));
  assertAbsentResult(detectHonoRoot, scanHono, root);
});

test('Koa does not traverse a symlinked external source directory', (t) => {
  const { root, external } = stage(t, { koa: '3.2.1', '@koa/router': '15.7.0' });
  write(external, 'app.js', KOA);
  fs.mkdirSync(path.join(root, 'src'));
  fs.symlinkSync(external, path.join(root, 'src', 'external'));
  assertAbsentResult(detectKoaRouterRoot, scanKoaRouter, root);
});

test('Next.js ignores a symlinked nested app route directory', (t) => {
  const { root, external } = stage(t, { next: '16.4.0-canary.45' });
  write(external, 'api/route.ts', 'export async function GET() {}\n');
  fs.mkdirSync(path.join(root, 'app'));
  fs.symlinkSync(external, path.join(root, 'app', 'external'));
  assertAbsentResult(detectNextRoot, scanNext, root);
});

test('Next.js must not read a symlinked top-level app directory', (t) => {
  const { root, external } = stage(t, { next: '16.4.0-canary.45' });
  write(external, 'app/api/route.ts', 'export async function GET() {}\n');
  fs.symlinkSync(path.join(external, 'app'), path.join(root, 'app'));
  assertAbsentResult(detectNextRoot, scanNext, root);
});

test('Next.js ignores a symlinked src/ parent of an app tree', (t) => {
  const { root, external } = stage(t, { next: '16.4.0-canary.45' });
  write(external, 'app/api/route.ts', 'export async function GET() {}\n');
  fs.symlinkSync(external, path.join(root, 'src'));
  assertAbsentResult(detectNextRoot, scanNext, root);
});

test('Next.js ignores a symlinked pages/api directory', (t) => {
  const { root, external } = stage(t, { next: '16.4.0-canary.45' });
  write(external, 'users.ts', 'export default function handler(req, res) {}\n');
  fs.mkdirSync(path.join(root, 'pages'));
  fs.symlinkSync(external, path.join(root, 'pages', 'api'));
  assertAbsentResult(detectNextRoot, scanNext, root);
});

test('Next.js treats a symlinked next.config.js as unresolved rather than adopting outside basePath', (t) => {
  const { root, external } = stage(t, { next: '16.4.0-canary.45' });
  write(root, 'app/api/route.ts', 'export async function GET() {}\n');
  write(external, 'next.config.js', "module.exports = { basePath: '/outside' };\n");
  fs.symlinkSync(path.join(external, 'next.config.js'), path.join(root, 'next.config.js'));
  assert.ok(detectNextRoot(root));
  const scanned = scanNext(root);
  assert.deepEqual(scanned.modules, [], 'unknown external basePath must not produce guessed endpoint');
  assert.ok(scanned.scanNotes.some((note) => /next\.config\.js/.test(note) && /symlink|untrusted|unknown/i.test(note)),
    'a symlinked config must be diagnosed as unknown');
  assert.ok(!JSON.stringify(scanned).includes('/outside/api'), 'external basePath must not be accepted as a route');
});
