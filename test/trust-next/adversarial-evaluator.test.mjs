import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAdversarialResults } from '../../lib/trust-next/adversarial-evaluator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'adversarial-fixtures.json'), 'utf8'));

const evidenceRef = (id) => 'sha256:' + crypto.createHash('sha256').update(id).digest('hex');
const verifiedEvidenceRefs = (results) => [...new Set(results.flatMap((x) => x.evidence_refs ?? []))].sort();

function passingRunnerResults() {
  return SPEC.cases
    .filter((x) => ['runner', 'evidence'].includes(x.layer))
    .map((x) => ({
      id: x.id,
      outcome: 'pass',
      observer_kind: x.observer.kind,
      evidence_refs: [evidenceRef(x.id)],
    }));
}

test('complete externally observed runner/evidence results are T20-ready but not a runtime certification', () => {
  const results = passingRunnerResults();
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.required_count, 14);
  assert.equal(report.ready, true, JSON.stringify(report.errors));
  assert.deepEqual({ ...report.counts }, { pass: 14, fail: 0, blocked: 0, missing: 0 });
  assert.match(report.note, /certification still belongs to T16\/T19\/T00/);
});

test('missing result prevents readiness', () => {
  const results = passingRunnerResults();
  const removed = results.pop();
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  assert.equal(report.counts.missing, 1);
  assert.deepEqual(report.missing, [removed.id]);
});

test('pass without evidence ref is rejected', () => {
  const results = passingRunnerResults();
  results[0].evidence_refs = [];
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  assert.equal(report.errors.some((x) => x.code === 'RESULT_EVIDENCE_REQUIRED' && x.id === results[0].id), true);
});

test('observer mismatch is rejected even when the candidate calls the case pass', () => {
  const results = passingRunnerResults();
  results[0].observer_kind = 'validator';
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  assert.equal(report.errors.some((x) => x.code === 'RESULT_OBSERVER_MISMATCH'), true);
});

test('blocked infrastructure stays blocked with explicit reason', () => {
  const results = passingRunnerResults();
  const target = results.find((x) => x.id === 'TRUST-NET-01');
  target.outcome = 'blocked';
  target.evidence_refs = [];
  target.blocked_reason = 'network namespace unavailable on admitted runner';
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  assert.equal(report.counts.blocked, 1);
  assert.equal(report.results.find((x) => x.id === 'TRUST-NET-01').blocked_reason, target.blocked_reason);
});

test('actual failure remains failure and cannot be hidden as missing', () => {
  const results = passingRunnerResults();
  const target = results.find((x) => x.id === 'TRUST-PROC-03');
  target.outcome = 'fail';
  target.evidence_refs = [evidenceRef('process-tree-leak')];
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.missing, 0);
});

test('unknown/duplicate cases and unknown fields fail closed', () => {
  const results = passingRunnerResults();
  results.push({ ...results[0] });
  results.push({ id: 'TRUST-NET-99', outcome: 'pass', observer_kind: 'network-probe', evidence_refs: [evidenceRef('unknown')] });
  results[1].surprise = true;
  const report = evaluateAdversarialResults(SPEC, results, { verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.ready, false);
  for (const code of ['RESULT_DUPLICATE_CASE', 'RESULT_UNKNOWN_CASE', 'RESULT_UNKNOWN_FIELD']) {
    assert.equal(report.errors.some((x) => x.code === code), true, code);
  }
});

test('declaration-only evaluation can be requested separately without changing runner gate', () => {
  const results = SPEC.cases
    .filter((x) => x.layer === 'declaration')
    .map((x) => ({ id: x.id, outcome: 'pass', observer_kind: 'validator', evidence_refs: [evidenceRef(x.id)] }));
  const report = evaluateAdversarialResults(SPEC, results, { requiredLayers: ['declaration'], verifiedEvidenceRefs: verifiedEvidenceRefs(results) });
  assert.equal(report.required_count, 6);
  assert.equal(report.ready, true);
});


test('self-authored evidence refs do not become externally verified by being present in results', () => {
  const results = passingRunnerResults();
  const report = evaluateAdversarialResults(SPEC, results);
  assert.equal(report.ready, false);
  assert.equal(report.errors.some((x) => x.code === 'RESULT_EVIDENCE_NOT_VERIFIED'), true);
});
