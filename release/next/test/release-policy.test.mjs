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

test('accepts a structurally valid epoch-4 inventory while release stays blocked', () => {
  const result = verifyAll(inventory, plan);
  assert.equal(result.ok, true);
  assert.deepEqual(result.inventory.errors, []);
  assert.deepEqual(result.release_plan.errors, []);
  assert.deepEqual(result.inventory.observed_blockers, [
    'BASELINE_NOT_ACCEPTED',
    'CURRENT_MAIN_CI_NOT_GREEN',
    'CURRENT_MAIN_INTEGRATION_INCOMPLETE',
  ]);
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

test('epoch-4 coordination baseline matches all currently observed mains', () => {
  assert.equal(observedBlockers(inventory).includes('COORDINATION_BASELINE_DRIFT'), false);
  for (const repo of inventory.repositories) {
    assert.equal(repo.coordination_sha, repo.head_sha);
  }
});

test('records non-green exact-head CI as a release blocker', () => {
  const beval = inventory.repositories.find((r) => r.role === 'beval');
  assert.equal(beval.exact_head_ci.status, 'completed');
  assert.equal(beval.exact_head_ci.conclusion, 'cancelled');
  assert.ok(observedBlockers(inventory).includes('CURRENT_MAIN_CI_NOT_GREEN'));
});

test('rejects exact-head CI attached to a different commit', () => {
  const x = clone(inventory); x.repositories[1].exact_head_ci.head_sha = '0'.repeat(40);
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'CI_HEAD_MISMATCH'));
});

test('rejects a stale release plan that does not mirror observed main', () => {
  const x = clone(plan); x.observed_current_main.becoder = '0'.repeat(40);
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'PLAN_OBSERVED_MAIN_STALE'));
});

test('rejects premature release while baseline/CI/dependency blockers remain', () => {
  const x = clone(plan); x.release_allowed = true;
  assert.ok(verifyReleasePlan(x, inventory).errors.some((e) => e.code === 'PREMATURE_RELEASE'));
});

test('rejects a plan that hides the observed integration blocker', () => {
  const x = clone(plan); x.blockers = x.blockers.filter((v) => v !== 'CURRENT_MAIN_INTEGRATION_INCOMPLETE');
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

test('runner recovery does not clear the blocker when beval integration did not complete', () => {
  const beval = inventory.repositories.find((r) => r.role === 'beval');
  assert.equal(beval.integration_observation.runner_name, 'alienware-wsl2-backend-ci');
  assert.notEqual(beval.integration_observation.conclusion, 'success');
  assert.ok(observedBlockers(inventory).includes('CURRENT_MAIN_INTEGRATION_INCOMPLETE'));
});

test('even a synthetic green overall CI flag cannot hide a recorded failed integration job', () => {
  const x = clone(inventory);
  const beval = x.repositories.find((r) => r.role === 'beval');
  beval.exact_head_ci.status = 'completed';
  beval.exact_head_ci.conclusion = 'success';
  const blockers = observedBlockers(x);
  assert.equal(blockers.includes('CURRENT_MAIN_CI_NOT_GREEN'), false);
  assert.equal(blockers.includes('CURRENT_MAIN_INTEGRATION_INCOMPLETE'), true);
});
