import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMutationCampaign, validateMutationCatalog } from './mutation-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(HERE, 'mutations.json'), 'utf8'));

test('mutation catalog is structurally safe and limited to T19-owned test paths', () => {
  const result = validateMutationCatalog(CATALOG);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.mutants, 7);
});

test('actual T19 mutation campaign kills every critical mutant and meets the noncritical gate', () => {
  const result = runMutationCampaign({ repoRoot: ROOT, catalog: CATALOG });
  assert.equal(result.catalog_errors.length, 0, result.catalog_errors.join('\n'));
  assert.equal(result.pass, true, JSON.stringify(result, null, 2));
  assert.equal(result.gate.critical_failures.length, 0);
  assert.equal(result.gate.noncritical_score, 1);
  assert.deepEqual(result.mutants.map((m) => m.status), Array(result.mutants.length).fill('killed'));
});

test('mutation catalog rejects a source path outside the T19 namespace', () => {
  const bad = structuredClone(CATALOG);
  bad.mutants[0].file = 'scanners/index.mjs';
  const result = validateMutationCatalog(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('T19 test paths')));
});
