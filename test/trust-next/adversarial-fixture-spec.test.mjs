import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVERSARIAL_FIXTURE_SCHEMA, summarizeAdversarialFixtureSpec, validateAdversarialFixtureSpec } from '../../lib/trust-next/adversarial-fixture-spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, 'adversarial-fixtures.json'), 'utf8'));

test('committed T20 adversarial fixture spec is valid, unique and explicitly non-self-reporting', () => {
  const result = validateAdversarialFixtureSpec(SPEC);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.schema, ADVERSARIAL_FIXTURE_SCHEMA);
  assert.equal(result.value.cases.length, 20);
  assert.equal(new Set(result.value.cases.map((x) => x.id)).size, 20);
  assert.equal(result.value.cases.every((x) => x.self_report_sufficient === false), true);
});

test('fixture summary distinguishes declaration coverage from pending runner/evidence enforcement', () => {
  const summary = summarizeAdversarialFixtureSpec(SPEC);
  assert.deepEqual({ ...summary.by_layer }, { declaration: 6, runner: 13, evidence: 1 });
  assert.deepEqual({ ...summary.by_status }, { 'covered-unit': 6, 'specified-not-implemented': 14 });
  assert.equal(summary.runner_enforcement_ready, 13);
});

test('runner/evidence cases cannot claim unit coverage before enforcement exists', () => {
  const x = structuredClone(SPEC);
  const item = x.cases.find((c) => c.layer === 'runner');
  item.status = 'covered-unit';
  item.test_refs = ['test/fake.test.mjs'];
  const result = validateAdversarialFixtureSpec(x);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'RUNTIME_COVERAGE_OVERCLAIM'), true);
});

test('candidate self-report can never be sufficient evidence', () => {
  const x = structuredClone(SPEC);
  x.cases[0].self_report_sufficient = true;
  const result = validateAdversarialFixtureSpec(x);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'SELF_REPORT_FORBIDDEN'), true);
});

test('runner cases require an external observer rather than the declaration validator', () => {
  const x = structuredClone(SPEC);
  const item = x.cases.find((c) => c.layer === 'runner');
  item.observer.kind = 'validator';
  const result = validateAdversarialFixtureSpec(x);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'WEAK_RUNTIME_OBSERVER'), true);
});

test('duplicate IDs and unknown fields fail closed', () => {
  const x = structuredClone(SPEC);
  x.cases[1].id = x.cases[0].id;
  x.cases[0].surprise = true;
  const result = validateAdversarialFixtureSpec(x);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'DUPLICATE_CASE_ID'), true);
  assert.equal(result.errors.some((e) => e.code === 'UNKNOWN_FIELD'), true);
});

test('unimplemented cases cannot carry test refs that imply coverage', () => {
  const x = structuredClone(SPEC);
  const item = x.cases.find((c) => c.status === 'specified-not-implemented');
  item.test_refs = ['test/fake-pass.test.mjs'];
  const result = validateAdversarialFixtureSpec(x);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'UNIMPLEMENTED_WITH_TEST_REF'), true);
});
