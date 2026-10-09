import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Guards the mutation catalog against drift. The official runner (test/conformance-next/product-mutation-runner.mjs)
// applies the mutants; this file checks, from the committed files, that every mutant is applicable
// (its anchor occurs exactly once), still parses (a mutant that does not parse would be "killed" for the wrong
// reason), belongs to a real trust negative vector, and names test files that exist.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'trust-next', 'enforcement-gate-mutations.json'), 'utf8'));
const GATE_FILE = 'lib/trust-next/enforcement-gate.mjs';

function collectIds(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectIds(item, found));
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string') found.add(value.id);
    Object.values(value).forEach((item) => collectIds(item, found));
  }
  return found;
}

test('the catalog is well formed: contract, unique ids, required fields', () => {
  assert.equal(catalog.contract, 'sbf.qa-product-mutation-catalog/1');
  assert.ok(Array.isArray(catalog.mutants) && catalog.mutants.length >= 12);
  const ids = catalog.mutants.map((mutant) => mutant.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const mutant of catalog.mutants) {
    assert.match(mutant.id, /^PMUT-GATE-[A-Z0-9-]+$/);
    assert.equal(mutant.file, GATE_FILE);
    assert.equal(typeof mutant.critical, 'boolean');
    for (const key of ['find', 'replace', 'invariant']) assert.ok(typeof mutant[key] === 'string' && mutant[key].length > 0, `${mutant.id}.${key}`);
    assert.notEqual(mutant.find, mutant.replace);
    assert.ok(Number.isInteger(mutant.timeout_ms) && mutant.timeout_ms >= 1000 && mutant.timeout_ms <= 120000);
    assert.ok(Array.isArray(mutant.test_files) && mutant.test_files.length > 0);
    for (const file of mutant.test_files) {
      assert.match(file, /^test\/trust-next\/[a-z0-9-]+\.test\.mjs$/);
      assert.ok(fs.existsSync(path.join(repoRoot, file)), `${mutant.id}: missing ${file}`);
    }
  }
});

test('every anchor occurs exactly once in the gate source and every mutated source still parses', () => {
  const source = fs.readFileSync(path.join(repoRoot, GATE_FILE), 'utf8');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bskel-gate-mutants-'));
  try {
    for (const mutant of catalog.mutants) {
      assert.equal(source.split(mutant.find).length - 1, 1, `${mutant.id}: anchor must occur exactly once`);
      const file = path.join(dir, `${mutant.id}.mjs`);
      fs.writeFileSync(file, source.replace(mutant.find, () => mutant.replace));
      const checked = spawnSync(process.execPath, ['--check', file], { env: {}, encoding: 'utf8' });
      assert.equal(checked.status, 0, `${mutant.id} does not parse: ${checked.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every mutant belongs to a trust negative vector that exists in the corpus', () => {
  const ids = collectIds(JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'corpus-next', 'negative-vectors.json'), 'utf8')));
  for (const mutant of catalog.mutants) {
    assert.match(mutant.vector_id, /^NEG-TRUST-\d+$/);
    assert.ok(ids.has(mutant.vector_id), `${mutant.id}: ${mutant.vector_id} is not in the corpus`);
  }
});

test('the catalog exercises every operation the gate mediates', () => {
  const text = JSON.stringify(catalog.mutants.map((mutant) => mutant.id));
  for (const part of ['CANONICAL', 'ESCAPE-ROOT', 'LEXICAL', 'NON-PUBLIC', 'LISTEN', 'ENV', 'SECRET', 'DEVICE', 'EXECUTABLE', 'MAX-CHILDREN', 'UNKNOWN-OPERATION', 'WALL', 'OUTPUT']) {
    assert.ok(text.includes(part), `no mutant for ${part}`);
  }
});

test('the catalog covers the values a caller keeps hold of and the properties the verifier binds a log to', () => {
  const text = JSON.stringify(catalog.mutants.map((mutant) => mutant.id));
  for (const part of ['SPAWN-ARGS', 'SPAWN-ENV', 'WRITE-BYTES', 'TIMERS', 'OUTPUT-CHUNK', 'AUDIT-RETURNS', 'AUDIT-ENTRY-NOT-FROZEN', 'MODE-BINDING', 'EXPECTED-MODE', 'AUDIT-TIME']) {
    assert.ok(text.includes(part), `no mutant for ${part}`);
  }
});
