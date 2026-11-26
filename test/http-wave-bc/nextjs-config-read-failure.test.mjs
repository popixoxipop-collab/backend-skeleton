import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter, scanNext } from '../../adapters/http-wave-bc/typescript-nextjs/adapter.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't13-config-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '16.4.0-canary.45' } }));
  fs.mkdirSync(path.join(root, 'app/api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/api/route.js'), 'export function GET() {}');
  return root;
}
const paths = report => report.modules.flatMap(m => m.controllers.flatMap(c => c.endpoints.map(e => e.path)));

// EISDIR is a real read failure without depending on chmod semantics or user ID.
for (const name of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']) {
  test(`unreadable ${name} withholds paths and recovers after repair`, t => {
    const root = fixture(t), config = path.join(root, name);
    fs.mkdirSync(config);
    assert.throws(() => fs.readFileSync(config, 'utf8'), { code: 'EISDIR' });
    const report = scanNext(root);
    assert.deepEqual(paths(report), []);
    assert.ok(report.scanNotes.some(n => n.includes('config is unreadable')));
    fs.rmdirSync(config);
    fs.writeFileSync(config, "module.exports = { basePath: '/docs' }");
    assert.deepEqual(paths(scanNext(root)), ['/docs/api']);
  });
}
test('a readable config cannot override an unreadable sibling', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'next.config.js'), "module.exports = { basePath: '/docs' }");
  fs.mkdirSync(path.join(root, 'next.config.mjs'));
  assert.deepEqual(paths(scanNext(root)), []);
});
test('absence of config keeps the documented empty basePath', t => {
  assert.deepEqual(paths(scanNext(fixture(t))), ['/api']);
});

// Keep actual permission denial distinct from directory-read failure.
// Root and Windows cannot provide this POSIX permission oracle.
for (const name of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']) {
  test(`EACCES ${name} fails closed through public entrypoints`, {
    skip: process.platform === 'win32' || process.getuid?.() === 0
      ? 'requires a non-root POSIX account for genuine EACCES' : false,
  }, t => {
    const root = fixture(t), config = path.join(root, name);
    fs.writeFileSync(config, "module.exports = { basePath: '/docs' }");
    const detection = adapter.detect(root);
    assert.ok(detection);
    assert.deepEqual(paths(adapter.scan(root, detection)), ['/docs/api']);
    fs.chmodSync(config, 0);
    try {
      assert.throws(() => fs.readFileSync(config, 'utf8'), { code: 'EACCES' });
      for (const report of [scanNext(root), adapter.scan(root, detection)]) {
        assert.deepEqual(paths(report), []);
        assert.ok(report.scanNotes.some(n => n.includes('config is unreadable')));
      }
      assert.ok(adapter.listReadSet(root, detection).some(p => p.endsWith(name)));
    } finally {
      fs.chmodSync(config, 0o600);
    }
    assert.deepEqual(paths(adapter.scan(root, detection)), ['/docs/api']);
  });
}
