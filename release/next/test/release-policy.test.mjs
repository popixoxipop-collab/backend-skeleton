import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAll, verifyCompatibilityInventory, verifyReleasePlan } from '../release-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-plan.json'), 'utf8'));
const clone = (x) => structuredClone(x);

test('accepts the pinned T23 compatibility inventory and blocked release plan', () => {
  assert.deepEqual(verifyAll(inventory, plan), {
    ok: true,
    inventory: { ok: true, errors: [] },
    release_plan: { ok: true, errors: [] },
  });
});

test('rejects source-only compatibility when a packed-package smoke disappears', () => {
  const x = clone(inventory);
  x.repositories[1].package.pack_test = null;
  assert.equal(verifyCompatibilityInventory(x).errors[0].code, 'PACK_TEST_REQUIRED');
});

test('rejects mutable or missing commit identity', () => {
  const x = clone(inventory);
  x.repositories[0].head_sha = 'main';
  assert.equal(verifyCompatibilityInventory(x).errors[0].code, 'UNPINNED_HEAD');
});

test('rejects premature release while T00/QA/trust/integration blockers remain', () => {
  const x = clone(plan);
  x.release_allowed = true;
  assert.equal(verifyReleasePlan(x).errors[0].code, 'PREMATURE_RELEASE');
});

test('rejects reordered migration that enables a writer before consumer shadowing', () => {
  const x = clone(plan);
  [x.migration_stages[1], x.migration_stages[2]] = [x.migration_stages[2], x.migration_stages[1]];
  assert.equal(verifyReleasePlan(x).errors[0].code, 'MIGRATION_ORDER');
});

test('rejects destructive rollback and historical evidence deletion', () => {
  const x = clone(plan);
  x.rollback_policy.destructive_down_migration_allowed = true;
  x.rollback_policy.delete_historical_evidence_allowed = true;
  const codes = verifyReleasePlan(x).errors.map((e) => e.code);
  assert.ok(codes.includes('DESTRUCTIVE_DOWN_MIGRATION'));
  assert.ok(codes.includes('HISTORICAL_EVIDENCE_DELETE'));
});

test('rejects old writer overwriting next artifacts', () => {
  const x = clone(plan);
  x.rollback_policy.old_writer_may_overwrite_next_artifacts = true;
  assert.ok(verifyReleasePlan(x).errors.some((e) => e.code === 'OLD_WRITER_OVERWRITE'));
});

test('rejects privileged pull_request_target plan for untrusted candidate code', () => {
  const x = clone(plan);
  x.ci_lane_plan.privileged_pull_request_target_for_untrusted_code = true;
  assert.ok(verifyReleasePlan(x).errors.some((e) => e.code === 'UNTRUSTED_PRIVILEGED_PR'));
});
