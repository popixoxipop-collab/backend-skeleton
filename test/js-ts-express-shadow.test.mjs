import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { adapter as javascriptExpressAdapter } from '../scanners/adapters/javascript-express.mjs';
import { adapter as typescriptExpressAdapter } from '../scanners/adapters/typescript-express.mjs';
import { analyzeAdapterJsTsShadow } from '../scanners/language/js-ts/adapter-shadow.mjs';

function tempRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function buildJavaScriptExpressRepo() {
  const root = tempRepo('bskel-t04-js-shadow-');
  write(root, 'package.json', JSON.stringify({
    type: 'module',
    dependencies: { express: '^4.18.2' },
  }, null, 2));
  write(root, 'src/app.js', `
import express from 'express';
import users from './users.js';
const app = express();
app.use('/api/users', users);
export default app;
`);
  write(root, 'src/users.js', `
import express from 'express';
const router = express.Router();
router.get('/:id', (_req, res) => res.json({ id: 1 }));
export default router;
`);
  return root;
}

function buildTypeScriptExpressRepo() {
  const root = tempRepo('bskel-t04-ts-shadow-');
  write(root, 'package.json', JSON.stringify({
    dependencies: { express: '^4.18.2', typeorm: '^0.3.20' },
    devDependencies: { typescript: '^5.9.0' },
  }, null, 2));
  write(root, 'src/routes/index.ts', `
import { Router } from 'express';
import users from './users';
const router = Router();
router.use('/users', users);
export default router;
`);
  write(root, 'src/routes/users.ts', `
import { Router } from 'express';
const router = Router();
router.get('/:id', show);
function show(_req: unknown, _res: unknown) {}
export default router;
`);
  return root;
}

test('JavaScript Express read-set can be shadowed without changing the shipped adapter scan result', () => {
  const root = buildJavaScriptExpressRepo();
  const detectionBefore = javascriptExpressAdapter.detect(root);
  assert.ok(detectionBefore);
  const before = javascriptExpressAdapter.scan(root, detectionBefore);

  const shadow = analyzeAdapterJsTsShadow(javascriptExpressAdapter, root);
  assert.equal(shadow.detected, true);
  assert.deepEqual(shadow.readSet, ['src/app.js', 'src/users.js']);
  assert.deepEqual(shadow.skippedReadSet, []);
  assert.equal(shadow.snapshot.complete, true);
  assert.equal(shadow.snapshot.syntaxValidated, false);

  const relative = shadow.snapshot.moduleGraph.filter((edge) => edge.specifier.startsWith('.'));
  assert.equal(relative.length, 1);
  assert.equal(relative[0].specifier, './users.js');
  assert.equal(relative[0].status, 'resolved');
  assert.equal(relative[0].target, 'src/users.js');

  const bare = shadow.snapshot.moduleGraph.filter((edge) => edge.specifier === 'express');
  assert.equal(bare.length, 2);
  assert.ok(bare.every((edge) => edge.status === 'bare'));

  const detectionAfter = javascriptExpressAdapter.detect(root);
  const after = javascriptExpressAdapter.scan(root, detectionAfter);
  assert.deepEqual(after, before);
});

test('TypeScript Express extensionless router import resolves only from the adapter read-set inventory', () => {
  const root = buildTypeScriptExpressRepo();
  const shadow = analyzeAdapterJsTsShadow(typescriptExpressAdapter, root);
  assert.equal(shadow.detected, true);
  assert.deepEqual(shadow.readSet, ['src/routes/index.ts', 'src/routes/users.ts']);
  assert.equal(shadow.snapshot.complete, true);
  assert.equal(shadow.snapshot.syntaxValidated, false);

  const users = shadow.snapshot.moduleGraph.find((edge) => edge.specifier === './users');
  assert.ok(users);
  assert.equal(users.status, 'resolved');
  assert.equal(users.target, 'src/routes/users.ts');
  assert.ok(shadow.snapshot.moduleGraph.filter((edge) => edge.specifier === 'express').every((edge) => edge.status === 'bare'));
});

test('not-detected adapter returns no snapshot and never calls listReadSet', () => {
  let listed = false;
  const adapter = {
    id: 'fake',
    detect: () => null,
    listReadSet: () => { listed = true; throw new Error('must not run'); },
  };
  const root = tempRepo('bskel-t04-shadow-none-');
  const result = analyzeAdapterJsTsShadow(adapter, root);
  assert.equal(result.detected, false);
  assert.equal(result.snapshot, null);
  assert.equal(listed, false);
});

test('non-JS/TS entries remain visible in readSet but are skipped from the language snapshot', () => {
  const root = tempRepo('bskel-t04-shadow-skip-');
  write(root, 'package.json', '{}');
  write(root, 'src/app.js', "import './dep.js';\n");
  write(root, 'src/dep.js', '');
  const adapter = {
    id: 'fake',
    detect: () => ({ projectRoot: root }),
    listReadSet: () => ['package.json', 'src/app.js', 'src/dep.js'],
  };
  const result = analyzeAdapterJsTsShadow(adapter, root);
  assert.deepEqual(result.skippedReadSet, ['package.json']);
  assert.deepEqual(result.snapshot.files.map((f) => f.path), ['src/app.js', 'src/dep.js']);
  assert.equal(result.snapshot.moduleGraph[0].target, 'src/dep.js');
});

test('read byte budget fails closed before emitting a partial shadow graph', () => {
  const root = tempRepo('bskel-t04-shadow-limit-');
  write(root, 'src/app.js', "import './dep.js';\n");
  write(root, 'src/dep.js', '');
  const adapter = {
    id: 'fake',
    detect: () => true,
    listReadSet: () => ['src/app.js', 'src/dep.js'],
  };
  const result = analyzeAdapterJsTsShadow(adapter, root, { maxReadBytes: 2 });
  assert.equal(result.detected, true);
  assert.equal(result.snapshot.complete, false);
  assert.equal(result.snapshot.allResolved, false);
  assert.equal(result.snapshot.syntaxValidated, false);
  assert.deepEqual(result.snapshot.moduleGraph, []);
  assert.equal(result.snapshot.diagnostics[0].code, 'shadow-read-limit');
});

test('duplicate normalized read-set paths are rejected', () => {
  const root = tempRepo('bskel-t04-shadow-duplicate-');
  write(root, 'src/app.js', '');
  const adapter = {
    id: 'fake',
    detect: () => true,
    listReadSet: () => ['src/app.js', path.join('src', '.', 'app.js')],
  };
  assert.throws(() => analyzeAdapterJsTsShadow(adapter, root), /duplicate paths/);
});

test('symlink escape outside repoRoot is rejected when the platform permits creating the symlink', (t) => {
  const root = tempRepo('bskel-t04-shadow-link-');
  const outside = path.join(tempRepo('bskel-t04-shadow-outside-'), 'secret.js');
  fs.writeFileSync(outside, 'export const secret = 1;');
  const link = path.join(root, 'linked.js');
  try {
    fs.symlinkSync(outside, link);
  } catch (error) {
    t.skip(`symlink unavailable on this platform: ${error.code ?? error.message}`);
    return;
  }
  const adapter = {
    id: 'fake',
    detect: () => true,
    listReadSet: () => ['linked.js'],
  };
  assert.throws(() => analyzeAdapterJsTsShadow(adapter, root), /symlink escapes/);
});
