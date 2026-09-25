import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareObservedInventory,
  evaluateMutationGate,
  sha256,
  validateCorpusManifest,
  validateNegativeVectorCatalog,
  verifyEvidencePack,
} from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, '..', 'corpus-next', 'corpus-manifest.json');
const NEGATIVE = path.join(HERE, '..', 'corpus-next', 'negative-vectors.json');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('corpus manifest accepts only exact pinned, licensed reference entries and reports holdout readiness honestly', () => {
  const result = validateCorpusManifest(readJson(CORPUS));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.reference_entries, 4);
  assert.equal(result.stats.holdout_entries, 0);
  assert.equal(result.stats.holdout_ready, false);
});

test('corpus manifest rejects a floating ref', () => {
  const manifest = readJson(CORPUS);
  manifest.entries[0].ref = 'main';
  const result = validateCorpusManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('exact 40-hex commit')));
});

test('corpus manifest rejects reference/holdout leakage from the same source family', () => {
  const manifest = readJson(CORPUS);
  manifest.holdout_entries.push({ ...manifest.entries[0], id: 'leaked-holdout' });
  manifest.entries = manifest.entries.slice(1);
  manifest.entries.push({ ...manifest.entries[0], id: 'same-family-reference', source_family: 'spring-petclinic' });
  const result = validateCorpusManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('crosses reference and holdout')));
});

test('negative vector catalog is structured, unique, and covers all initial categories', () => {
  const result = validateNegativeVectorCatalog(readJson(NEGATIVE));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.stats.vectors, 24);
  for (const count of Object.values(result.stats.categories)) assert.ok(count >= 2);
});

test('full-surface recall counts abstention as false-negative while reporting abstention separately', () => {
  const result = compareObservedInventory({
    gold: ['GET /a', 'GET /b', 'POST /c'],
    observed: [
      { id: 'GET /a', status: 'verified' },
      { id: 'GET /b', status: 'unknown' },
      { id: 'DELETE /ghost', status: 'verified' },
    ],
  });
  assert.deepEqual({ tp: result.tp, fp: result.fp, fn: result.fn, abstentions: result.abstentions, missing: result.missing }, { tp: 1, fp: 1, fn: 2, abstentions: 1, missing: 1 });
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 1 / 3);
  assert.equal(result.abstention_rate, 1 / 3);
});

test('inventory comparator rejects duplicate observations instead of silently picking one', () => {
  assert.throws(() => compareObservedInventory({ gold: ['A'], observed: [{ id: 'A', status: 'verified' }, { id: 'A', status: 'unknown' }] }), /duplicate observed id/);
});

test('mutation gate kills every critical mutant and excludes reviewed equivalent noncritical mutants', () => {
  const result = evaluateMutationGate({ mutants: [
    { id: 'critical-hash', critical: true, status: 'killed' },
    { id: 'normal-a', critical: false, status: 'killed' },
    { id: 'normal-b', critical: false, status: 'killed' },
    { id: 'normal-equivalent', critical: false, status: 'equivalent' },
  ] });
  assert.equal(result.pass, true);
  assert.equal(result.noncritical_score, 1);
  assert.deepEqual(result.equivalent_excluded, ['normal-equivalent']);
});

test('mutation gate fails when any critical mutant survives', () => {
  const result = evaluateMutationGate({ mutants: [
    { id: 'critical-replay', critical: true, status: 'survived' },
    { id: 'normal', critical: false, status: 'killed' },
  ] });
  assert.equal(result.pass, false);
  assert.deepEqual(result.critical_failures, ['critical-replay']);
});

test('mutation gate does not call an empty noncritical denominator 100 percent', () => {
  const result = evaluateMutationGate({ mutants: [{ id: 'critical', critical: true, status: 'killed' }] });
  assert.equal(result.pass, false);
  assert.equal(result.noncritical_score, null);
  assert.match(result.reasons[0], /no executable noncritical mutants/);
});

test('evidence pack validates artifact bytes and required assertions before accepting pass', () => {
  const body = Buffer.from('raw evidence\n');
  const pack = {
    contract: 'sbf.qa-evidence/1',
    scope: 'java-spring@fixture:api.routes',
    source_commit: 'a'.repeat(40),
    adapter_id: 'java-spring',
    target_profile: 'synthetic-node-test',
    verdict: 'pass',
    commands: [{ argv: 'node --test test/conformance-next/harness.test.mjs', status: 'executed', exit_code: 0 }],
    assertions: [{ id: 'routes-match', required: true, status: 'passed' }],
    artifacts: [{ path: 'raw/routes.json', sha256: sha256(body), size_bytes: body.length }],
  };
  const result = verifyEvidencePack(pack, { artifactBytes: new Map([['raw/routes.json', body]]) });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('pass evidence cannot hide a required skipped command or mismatched artifact', () => {
  const expected = Buffer.from('expected');
  const actual = Buffer.from('tampered');
  const pack = {
    contract: 'sbf.qa-evidence/1', scope: 'x', source_commit: 'b'.repeat(40), adapter_id: 'x', target_profile: 'x', verdict: 'pass',
    commands: [{ argv: 'real runtime', status: 'skipped', reason: 'runner unavailable' }],
    assertions: [{ id: 'required-runtime', required: true, status: 'passed' }],
    artifacts: [{ path: 'raw/result', sha256: sha256(expected), size_bytes: expected.length }],
  };
  const result = verifyEvidencePack(pack, { artifactBytes: new Map([['raw/result', actual]]) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((x) => x.includes('pass verdict cannot hide')));
  assert.ok(result.errors.some((x) => x.includes('artifact')));
});

test('blocked evidence may record skipped infrastructure without masquerading as pass', () => {
  const pack = {
    contract: 'sbf.qa-evidence/1', scope: 'unreal:runtime', source_commit: 'c'.repeat(40), adapter_id: 'unreal', target_profile: 'engine-not-installed', verdict: 'blocked',
    commands: [{ argv: 'UnrealEditor-Cmd ...', status: 'blocked', reason: 'approved engine runtime unavailable' }],
    assertions: [{ id: 'runtime-state', required: false, status: 'blocked' }],
    artifacts: [],
  };
  const result = verifyEvidencePack(pack);
  assert.equal(result.ok, true, result.errors.join('\n'));
});
