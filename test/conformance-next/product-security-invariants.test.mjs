import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWithinRoot, sha256File } from '../../lib/fsutil.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

test('T19 product invariant: resolveWithinRoot rejects lexical parent traversal', () => {
  const root = path.resolve('t19-product-root');
  assert.equal(resolveWithinRoot(root, '../outside.txt'), null);
  assert.equal(resolveWithinRoot(root, 'nested/../../outside.txt'), null);
});

test('T19 product invariant: resolveWithinRoot preserves an in-root relative path', () => {
  const root = path.resolve('t19-product-root');
  assert.equal(resolveWithinRoot(root, 'nested/file.txt'), path.resolve(root, 'nested/file.txt'));
});


test('T19 product invariant: sha256File preserves exact-byte identity instead of semantic JSON equivalence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t19-byte-identity-'));
  try {
    const compact = path.join(dir, 'compact.json');
    const pretty = path.join(dir, 'pretty.json');
    fs.writeFileSync(compact, '{"a":1,"b":2}\n');
    fs.writeFileSync(pretty, '{\n  "a": 1,\n  "b": 2\n}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(compact, 'utf8')), JSON.parse(fs.readFileSync(pretty, 'utf8')));
    assert.notEqual(sha256File(compact), sha256File(pretty), 'semantic equality must not collapse exact-byte identity');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T19 product invariant: TypeScript generated access stub fails closed by throwing inside checkAccess', () => {
  const template = fs.readFileSync(path.join(ROOT, 'handles/providers/typescript-express/templates/resolver.ts.tmpl'), 'utf8');
  const block = template.match(/checkAccess\([^]*?\n  },/);
  assert.ok(block, 'expected checkAccess method in TypeScript resolver template');
  assert.match(block[0], /throw new HandleAccessDeniedError\(/);
  assert.doesNotMatch(block[0], /\breturn\s*;/);
});
