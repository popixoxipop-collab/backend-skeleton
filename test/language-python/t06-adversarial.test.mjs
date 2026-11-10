import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzePythonFile, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';

const runtimes = ['python3.11', 'python3.12']
  .map((pythonCommand) => findPythonRuntime({ pythonCommand }))
  .filter(Boolean);
const defaultRuntime = findPythonRuntime();

function withSource(source, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-adversarial-'));
  try {
    fs.writeFileSync(path.join(root, 'module.py'), source);
    return run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('T06 stable AST facts and syntax failures agree across Python 3.11 and 3.12',
  { skip: runtimes.length !== 2 && 'both Python 3.11 and 3.12 are required for this local matrix' }, () => {
    assert.notEqual(runtimes[0].version.split('.').slice(0, 2).join('.'),
      runtimes[1].version.split('.').slice(0, 2).join('.'));
    withSource('BIG = 9007199254740993\ndef route(a: int):\n    return a\n', (root) => {
      const facts = runtimes.map(({ executable }) => {
        const result = analyzePythonFile({ repoRoot: root, file: 'module.py', pythonCommand: executable });
        assert.equal(result.ok, true, JSON.stringify(result));
        return {
          assignment: result.facts.assignments[0].value,
          function: result.facts.functions[0].name,
          argument: result.facts.functions[0].arguments[0].name,
          sha256: result.source.sha256,
        };
      });
      assert.deepEqual(facts[0], facts[1]);
      assert.deepEqual(facts[0].assignment,
        { kind: 'integer', decimal: '9007199254740993', reason: 'outside-js-safe-integer' });
      fs.writeFileSync(path.join(root, 'module.py'), 'def broken(:\n');
      for (const { executable } of runtimes) {
        const result = analyzePythonFile({ repoRoot: root, file: 'module.py', pythonCommand: executable });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'PYTHON_SYNTAX_ERROR');
        assert.equal(result.source.path, 'module.py');
      }
    });
  });

test('T06 denies source symlinks whose real path leaves the project root', { skip: !defaultRuntime }, (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t06-symlink-'));
  try {
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, 'outside.py'), 'secret = 1\n');
    try { fs.symlinkSync(path.join(parent, 'outside.py'), path.join(root, 'module.py')); }
    catch (error) { t.skip(`symlink unsupported: ${error.code ?? error.message}`); return; }
    assert.throws(() => analyzePythonFile({ repoRoot: root, file: 'module.py' }),
      /Python source escapes project root/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('T06 rejects a late invalid UTF-8 byte after the encoding-detection lines',
  { skip: !defaultRuntime }, () => {
    const bytes = Buffer.concat([
      Buffer.from('# coding: utf-8\nname = "ok"\nmessage = "'),
      Buffer.from([0xff]),
      Buffer.from('"\n'),
    ]);
    withSource(bytes, (root) => {
      const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'PYTHON_SOURCE_ENCODING_UNSUPPORTED');
      assert.equal(result.source.sha256, createHash('sha256').update(bytes).digest('hex'));
    });
  });

test('T06 unreadable source bytes fail with EACCES before AST facts are returned',
  { skip: !defaultRuntime || process.getuid?.() === 0 }, () => {
    withSource('secret = 1\n', (root) => {
      const source = path.join(root, 'module.py');
      fs.chmodSync(source, 0);
      try {
        assert.throws(() => analyzePythonFile({ repoRoot: root, file: 'module.py' }),
          (error) => error?.code === 'EACCES');
      } finally { fs.chmodSync(source, 0o644); }
    });
  });
