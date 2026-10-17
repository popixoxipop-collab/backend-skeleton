// T13-04: deterministic metadata denial and source-leaf replacement tests.
// These tests modify ONLY generated temporary fixture trees, not real user repos.
// The simulated swap is not a proof against all directory-level TOCTOU races.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectNextRoot, scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t13-fd-boundary-'));
  t.after(() => fs.rmSync(parent, { force: true, recursive: true }));
  const root = path.join(parent, 'repo');
  const other = path.join(parent, 'external');
  fs.mkdirSync(root);
  fs.mkdirSync(other);
  put(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: { next: '16.4.0-canary.45' } }));
  put(root, 'app/api/route.ts', 'export async function GET() {}\n');
  assert.ok(detectNextRoot(root), 'an actual app route is detected before injection');
  return { root, other, route: path.join(root, 'app/api/route.ts'), config: path.join(root, 'next.config.js') };
}
function put(root, relative, data) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
function eacces() {
  return Object.assign(new Error('test fixture access denied'), { code: 'EACCES' });
}
function withDeniedFile(file, callback) {
  const previousRead = fs.readFileSync;
  const previousOpen = fs.openSync;
  fs.readFileSync = function (target, ...args) {
    if (target === file) throw eacces();
    return previousRead.call(this, target, ...args);
  };
  fs.openSync = function (target, ...args) {
    if (target === file) throw eacces();
    return previousOpen.call(this, target, ...args);
  };
  try {
    return callback();
  } finally {
    fs.readFileSync = previousRead;
    fs.openSync = previousOpen;
  }
}
function withDeniedLstat(file, callback) {
  const previous = fs.lstatSync;
  fs.lstatSync = function (target, ...args) {
    if (target === file) throw eacces();
    return previous.call(this, target, ...args);
  };
  try {
    return callback();
  } finally {
    fs.lstatSync = previous;
  }
}
function withSwapAtLeafRead(target, outside, callback) {
  let switched = false;
  const replace = () => {
    if (switched) return;
    switched = true;
    fs.unlinkSync(target);
    fs.symlinkSync(outside, target);
  };
  const oldRead = fs.readFileSync;
  const oldOpen = fs.openSync;
  fs.readFileSync = function (file, ...args) {
    if (file === target) replace();
    return oldRead.call(this, file, ...args);
  };
  fs.openSync = function (file, ...args) {
    if (file === target) replace();
    return oldOpen.call(this, file, ...args);
  };
  try {
    const result = callback();
    assert.ok(switched, 'swap hook must have fired on the actual read/open path');
    return result;
  } finally {
    fs.readFileSync = oldRead;
    fs.openSync = oldOpen;
  }
}
function noRoutes(report) {
  assert.deepEqual(report.modules, [], 'untrusted bytes must not produce an endpoint');
}
function note(report, token, condition) {
  assert.ok(report.scanNotes.some((s) => s.includes(token) && condition.test(s)),
    'expected an explicit uncertainty note for ' + token + ': ' + JSON.stringify(report.scanNotes));
}

test('Next.js refuses a config whose metadata cannot be inspected (EACCES)', (t) => {
  const { root, config } = fixture(t);
  fs.writeFileSync(config, "module.exports = { basePath: '/safe' };\n");
  const report = withDeniedLstat(config, () => scanNext(root));
  noRoutes(report);
  note(report, 'next.config.js', /metadata|inaccessible|could not be inspected/i);
});

test('Next.js explicitly marks an unreadable route file as incomplete', (t) => {
  const { root, route } = fixture(t);
  const report = withDeniedFile(route, () => scanNext(root));
  noRoutes(report);
  note(report, 'route.ts', /could not be read|unreadable|access denied|inaccessible/i);
});

test('Next.js refuses a next.config.js swapped into a symlink at open/read', (t) => {
  const { root, other, config } = fixture(t);
  fs.writeFileSync(config, "module.exports = { basePath: '/safe' };\n");
  const outside = path.join(other, 'evil.config.js');
  fs.writeFileSync(outside, "module.exports = { basePath: '/outside' };\n");
  const report = withSwapAtLeafRead(config, outside, () => scanNext(root));
  noRoutes(report);
  note(report, 'next.config.js', /symlink|untrusted|could not be read|unknown/i);
  assert.ok(!JSON.stringify(report).includes('/outside/api'));
});

test('Next.js refuses a route.ts swapped into a symlink at open/read', (t) => {
  const { root, other, route } = fixture(t);
  const outside = path.join(other, 'route.ts');
  fs.writeFileSync(outside, 'export async function POST() {}\n');
  const report = withSwapAtLeafRead(route, outside, () => scanNext(root));
  noRoutes(report);
  note(report, 'route.ts', /symlink|could not be read|unreadable|access denied|inaccessible/i);
  assert.ok(!JSON.stringify(report).includes('"POST"'));
});
