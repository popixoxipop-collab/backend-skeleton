import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';

const runtime = findPythonRuntime();

test('T06 preserves integers outside the JavaScript safe range as decimal strings', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-number-'));
  fs.writeFileSync(path.join(root, 'module.py'), 'BIG = 9007199254740993\nNEG = -9007199254740993\n');
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const byName = Object.fromEntries(result.facts.assignments.map((x) => [x.targets[0], x.value]));
  assert.deepEqual(byName.BIG, { kind: 'integer', decimal: '9007199254740993', reason: 'outside-js-safe-integer' });
  assert.deepEqual(byName.NEG, { kind: 'integer', decimal: '-9007199254740993', reason: 'outside-js-safe-integer' });
});

test('T06 represents non-finite Python float literals without emitting invalid JSON numbers', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-float-'));
  fs.writeFileSync(path.join(root, 'module.py'), 'HUGE = 1e999\n');
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.facts.assignments[0].value, { kind: 'float-special', value: 'Infinity', reason: 'non-finite-json-number' });
});

test('T06 keeps positional-only and keyword-only Python argument semantics', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-args-'));
  fs.writeFileSync(path.join(root, 'module.py'), 'def route(a: int, /, b: str = "x", *, c: bool = True):\n    pass\n');
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const fn = result.facts.functions[0];
  assert.deepEqual(fn.arguments.map((x) => [x.name, x.kind]), [
    ['a', 'positional-only'],
    ['b', 'positional'],
    ['c', 'keyword-only'],
  ]);
  assert.deepEqual(fn.arguments[0].default, { kind: 'missing' });
  assert.deepEqual(fn.arguments[1].default, { kind: 'constant', value: 'x' });
  assert.deepEqual(fn.arguments[2].default, { kind: 'constant', value: true });
});
