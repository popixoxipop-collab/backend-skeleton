import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedBlockers, verifyAll, verifyCompatibilityInventory, verifyReleasePlan } from '../release-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-plan.json'), 'utf8'));
const clone = (x) => structuredClone(x);

test('accepts a structurally valid observed inventory even while release is blocked', () => {
  const result = verifyAll(inventory, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.inventory.errors, []);
  assert.deepEqual(result.release_plan.errors, []);
  assert.deepEqual(result.inventory.observed_blockers, ['BASELINE_NOT_ACCEPTED', 'COORDINATION_BASELINE_DRIFT', 'CURRENT_MAIN_CI_NOT_GREEN']);
  assert.equal(plan.release_allowed, false);
});

test('rejects source-only compatibility when packed-package smoke disappears', () => {
  const x = clone(inventory); x.repositories[1].package.pack_test = null;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'PACK_TEST_REQUIRED'));
});

test('rejects mutable or missing commit identity', () => {
  const x = clone(inventory); x.repositories[0].head_sha = 'main';
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'UNPINNED_HEAD'));
});

test('records coordination baseline drift without pretending inventory is invalid', () => {
  assert.ok(observedBlockers(inventory).includes('COORDINATION_BASELINE_DRIFT'));
  assert.equal(verifyCompatibilityInventory(inventory).ok, true);
});

test('records queued exact-head CI as a release blocker, not as fake failure evidence', () => {
  assert.equal(inventory.repositories.find((r) => r.role === 'beval').exact_head_ci.status, 'queued');
  assert.ok(observedBlockers(inventory).includes('CURRENT_MAIN_CI_NOT_GREEN'));
  assert.equal(verifyCompatibilityInventory(inventory).ok, true);
});

test('rejects exact-head CI attached to a different commit', () => {
  const x = clone(inventory); x.repositories[1].exact_head_ci.head_sha = '0'.repeat(40);
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'CI_HEAD_MISMATCH'));
});

test('rejects a stale release plan that does not mirror observed main', () => {
  const x = clone(plan); x.observed_current_main.becoder = x.coordination_baseline.becoder;
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'PLAN_OBSERVED_MAIN_STALE'));
});

test('rejects premature release while baseline/CI/dependency blockers remain', () => {
  const x = clone(plan); x.release_allowed = true;
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'PREMATURE_RELEASE'));
});

test('rejects a plan that hides an observed blocker', () => {
  const x = clone(plan); x.blockers = x.blockers.filter((v) => v !== 'COORDINATION_BASELINE_DRIFT');
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED'));
});

test('rejects reordered migration that enables a writer before shadowing', () => {
  const x = clone(plan); [x.migration_stages[1], x.migration_stages[2]] = [x.migration_stages[2], x.migration_stages[1]];
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'MIGRATION_ORDER'));
});

test('rejects destructive rollback and historical evidence deletion', () => {
  const x = clone(plan); x.rollback_policy.destructive_down_migration_allowed = true; x.rollback_policy.delete_historical_evidence_allowed = true;
  const codes = verifyReleasePlan(x, inventory).errors.map((e) => e.code);
  assert.ok(codes.includes('DESTRUCTIVE_DOWN_MIGRATION')); assert.ok(codes.includes('HISTORICAL_EVIDENCE_DELETE'));
});

test('rejects old writer overwriting next artifacts', () => {
  const x = clone(plan); x.rollback_policy.old_writer_may_overwrite_next_artifacts = true;
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'OLD_WRITER_OVERWRITE'));
});

test('rejects privileged pull_request_target plan for untrusted candidate code', () => {
  const x = clone(plan); x.ci_lane_plan.privileged_pull_request_target_for_untrusted_code = true;
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'UNTRUSTED_PRIVILEGED_PR'));
});
