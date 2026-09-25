import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFiles, findPythonRuntime, PYTHON_AST_BATCH_RESPONSE_PROTOCOL } from '../../scanners/language/python/analyzer.mjs';

const runtime = findPythonRuntime();

test('T06 batch analysis returns deterministic source-path order from an explicit file list', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-batch-'));
  fs.writeFileSync(path.join(root, 'z.py'), 'z = 1\n');
  fs.writeFileSync(path.join(root, 'a.py'), 'a = 2\n');
  const result = analyzePythonFiles({ repoRoot: root, files: ['z.py', 'a.py'] });
  assert.equal(result.protocol, PYTHON_AST_BATCH_RESPONSE_PROTOCOL);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results.map((x) => x.source.path), ['a.py', 'z.py']);
  assert.match(result.runtime.version, /^\d+\.\d+\.\d+$/);
});

test('T06 batch analysis preserves per-file failures instead of dropping the whole project', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-batch-partial-'));
  fs.writeFileSync(path.join(root, 'good.py'), 'x = 1\n');
  fs.writeFileSync(path.join(root, 'bad.py'), 'def broken(:\n');
  const result = analyzePythonFiles({ repoRoot: root, files: ['good.py', 'bad.py'] });
  assert.equal(result.ok, false);
  const byPath = Object.fromEntries(result.results.map((x) => [x.source.path, x]));
  assert.equal(byPath['good.py'].ok, true);
  assert.equal(byPath['bad.py'].ok, false);
  assert.equal(byPath['bad.py'].error.code, 'PYTHON_SYNTAX_ERROR');
});

test('T06 batch analysis rejects duplicate real paths and excessive file lists before analysis', { skip: !runtime }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-batch-guard-'));
  fs.writeFileSync(path.join(root, 'one.py'), 'x = 1\n');
  try {
    fs.symlinkSync(path.join(root, 'one.py'), path.join(root, 'alias.py'));
    assert.throws(
      () => analyzePythonFiles({ repoRoot: root, files: ['one.py', 'alias.py'] }),
      /Duplicate Python source after realpath resolution/,
    );
  } catch (error) {
    if (error?.code) t.diagnostic(`symlink duplicate sub-check unavailable: ${error.code}`);
    else throw error;
  }
  assert.throws(
    () => analyzePythonFiles({ repoRoot: root, files: ['one.py', 'one.py'], maxFiles: 1 }),
    /exceeds configured 1-file analysis limit/,
  );
});
