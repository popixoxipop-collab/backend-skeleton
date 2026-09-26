import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, findPythonRuntime } from '../../scanners/language/python/analyzer.mjs';

const runtime = findPythonRuntime();

test('T06 hashes exact UTF-8 source bytes and reports their size', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-bytes-'));
  const bytes = Buffer.from('name = "김"\n', 'utf8');
  fs.writeFileSync(path.join(root, 'module.py'), bytes);
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true);
  assert.equal(result.source.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.source.sizeBytes, bytes.length);
});

test('T06 rejects oversized Python input before reading it into the helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-large-'));
  fs.writeFileSync(path.join(root, 'module.py'), Buffer.alloc(4096, 0x20));
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py', maxSourceBytes: 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PYTHON_SOURCE_TOO_LARGE');
  assert.equal(result.source.sizeBytes, 4096);
  assert.equal('sha256' in result.source, false, 'do not read/hash over-limit input just to report an error');
});

test('T06 rejects invalid default-UTF-8 source bytes rather than silently replacing characters', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-encoding-'));
  const bytes = Buffer.from([0x78, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a]);
  fs.writeFileSync(path.join(root, 'module.py'), bytes);
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PYTHON_SOURCE_ENCODING_UNSUPPORTED');
  assert.equal(result.source.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});


test('T06 honors a valid PEP 263 non-UTF-8 source encoding without changing the byte hash', { skip: !runtime }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-python-pep263-'));
  const bytes = Buffer.concat([
    Buffer.from('# coding: latin-1\nname = "caf', 'ascii'),
    Buffer.from([0xe9]),
    Buffer.from('"\n', 'ascii'),
  ]);
  fs.writeFileSync(path.join(root, 'module.py'), bytes);
  const result = analyzePythonFile({ repoRoot: root, file: 'module.py' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.source.encoding, 'iso-8859-1');
  assert.equal(result.facts.assignments[0].value.value, 'café');
});
