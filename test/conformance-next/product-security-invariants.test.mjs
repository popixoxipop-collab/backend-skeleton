import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithinRoot } from '../../lib/fsutil.mjs';

test('T19 product invariant: resolveWithinRoot rejects lexical parent traversal', () => {
  const root = path.resolve('t19-product-root');
  assert.equal(resolveWithinRoot(root, '../outside.txt'), null);
  assert.equal(resolveWithinRoot(root, 'nested/../../outside.txt'), null);
});

test('T19 product invariant: resolveWithinRoot preserves an in-root relative path', () => {
  const root = path.resolve('t19-product-root');
  assert.equal(resolveWithinRoot(root, 'nested/file.txt'), path.resolve(root, 'nested/file.txt'));
});
