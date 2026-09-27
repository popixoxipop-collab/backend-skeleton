import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEvidenceStore,
  observedBlockers,
  releasePlanBlockers,
  verifyAll,
  verifyCompatibilityInventory,
  verifyReleasePlan,
} from '../release-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-plan.json'), 'utf8'));
const evidenceStore = loadEvidenceStore(path.join(ROOT, 'evidence-manifest.json'));
const clone = (x) => structuredClone(x);
const verifyPlan = (candidate, inv = inventory, store = evidenceStore) => verifyReleasePlan(candidate, inv, store);

test('current integrated-main inventory is structurally valid but release remains blocked', () => {
  const result = verifyAll(inventory, plan, evidenceStore);
  assert.equal(evidenceStore.ok, true, JSON.stringify(evidenceStore.errors));
  assert.equal(result.ok, true);
  assert.deepEqual(result.inventory.errors, []);
  assert.deepEqual(result.release_plan.errors, []);
  assert.deepEqual(result.inventory.observed_blockers, [
    'FINAL_MAIN_PUSH_CI_NOT_DIRECT',
    'INDEPENDENT_QA_NOT_READY',
    'TRUST_POLICY_NOT_READY',
  ]);
  assert.deepEqual(releasePlanBlockers(plan, inventory, evidenceStore), [
    'FINAL_RELEASE_REHEARSAL_NOT_RUN',
    'RELEASE_CHECKS_NOT_COMPLETE',
  ]);
  assert.equal(plan.release_allowed, false);
  assert.equal(plan.default_activation_allowed, false);
});

test('role identity is pinned to exact repository and package names', () => {
  const wrongRepo = clone(inventory);
  wrongRepo.repositories[0].repo = 'popixoxipop-collab/not-bskel';
  assert.ok(verifyCompatibilityInventory(wrongRepo).errors.some((e) => e.code === 'REPOSITORY_IDENTITY_MISMATCH'));

  const wrongPackage = clone(inventory);
  wrongPackage.repositories[2].package.name = 'backend-skeleton';
  assert.ok(verifyCompatibilityInventory(wrongPackage).errors.some((e) => e.code === 'PACKAGE_IDENTITY_MISMATCH'));
});

test('zero-delta equivalence must be exact and still does not count as direct main CI', () => {
  const x = clone(inventory);
  x.repositories[0].verification.file_delta_count = 1;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'TREE_EQUIVALENCE'));
  assert.ok(observedBlockers(inventory).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('direct main CI cannot reuse an older or merely tree-equivalent CI head', () => {
  const x = clone(inventory);
  x.repositories[0].verification.direct_main_ci = true;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'DIRECT_CI_HEAD_MISMATCH'));
  assert.ok(observedBlockers(x).includes('FINAL_MAIN_PUSH_CI_NOT_DIRECT'));
});

test('promotion evidence is mandatory and its required state is fixed to ACCEPTED', () => {
  const missing = clone(inventory);
  delete missing.promotion_evidence.t19_03;
  assert.ok(verifyCompatibilityInventory(missing).errors.some((e) => e.code === 'PROMOTION_EVIDENCE_MISSING'));
  assert.ok(observedBlockers(missing).includes('INDEPENDENT_QA_NOT_READY'));

  const weakened = clone(inventory);
  weakened.promotion_evidence.t20_03.required_state = 'NOT_ACCEPTED';
  weakened.promotion_evidence.t20_03.observed_state = 'NOT_ACCEPTED';
  assert.ok(verifyCompatibilityInventory(weakened).errors.some((e) => e.code === 'PROMOTION_REQUIRED_STATE'));
  assert.ok(observedBlockers(weakened).includes('TRUST_POLICY_NOT_READY'));
});

test('release cannot hide an observed blocker', () => {
  const x = clone(plan);
  x.blockers = x.blockers.filter((v) => v !== 'TRUST_POLICY_NOT_READY');
  assert.ok(verifyPlan(x).errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED'));
});

test('every mandatory prerequisite remains present with its pinned required state', () => {
  const missing = clone(plan);
  missing.prerequisites = missing.prerequisites.filter((x) => x.id !== 'T00-04A');
  assert.ok(verifyPlan(missing).errors.some((e) => e.code === 'PREREQUISITE_MISSING'));

  const weakened = clone(plan);
  weakened.prerequisites.find((x) => x.id === 'T00-05').required_state = 'PLANNED';
  assert.ok(verifyPlan(weakened).errors.some((e) => e.code === 'PREREQUISITE_REQUIRED_STATE'));
});

test('migration stage IDs and safety semantics are immutable', () => {
  const reordered = clone(plan);
  [reordered.migration_stages[1], reordered.migration_stages[2]] = [reordered.migration_stages[2], reordered.migration_stages[1]];
  assert.ok(verifyPlan(reordered).errors.some((e) => e.code === 'MIGRATION_ORDER'));

  const widened = clone(plan);
  widened.migration_stages[0].writer_mode = 'next-global';
  widened.migration_stages[0].promotion = true;
  assert.ok(verifyPlan(widened).errors.some((e) => e.code === 'MIGRATION_STAGE_SEMANTICS'));
});

test('release rehearsal is a real gate and PASS requires resolved content-addressed evidence', () => {
  const hidden = clone(plan);
  hidden.blockers = hidden.blockers.filter((v) => v !== 'FINAL_RELEASE_REHEARSAL_NOT_RUN');
  assert.ok(verifyPlan(hidden).errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED'));

  const fakePass = clone(plan);
  fakePass.release_rehearsal.observed_state = 'PASS';
  fakePass.release_rehearsal.evidence_refs = ['sha256:' + '0'.repeat(64)];
  fakePass.blockers = fakePass.blockers.filter((v) => v !== 'FINAL_RELEASE_REHEARSAL_NOT_RUN');
  assert.ok(verifyPlan(fakePass).errors.some((e) => e.code === 'REHEARSAL_EVIDENCE_NOT_FOUND'));
  assert.ok(releasePlanBlockers(fakePass, inventory, evidenceStore).includes('FINAL_RELEASE_REHEARSAL_NOT_RUN'));
});

test('release cannot activate default writer while release gate is closed', () => {
  const x = clone(plan);
  x.default_activation_allowed = true;
  assert.ok(verifyPlan(x).errors.some((e) => e.code === 'PREMATURE_DEFAULT_ACTIVATION'));
});

test('destructive rollback, old-writer overwrite, and stale cache reuse remain forbidden', () => {
  const x = clone(plan);
  x.rollback_policy.destructive_down_migration_allowed = true;
  x.rollback_policy.old_writer_may_overwrite_next_artifacts = true;
  x.rollback_policy.cache_namespace_or_revision_must_change_on_semantic_revision = false;
  const codes = verifyPlan(x).errors.map((e) => e.code);
  assert.ok(codes.includes('DESTRUCTIVE_DOWN_MIGRATION'));
  assert.ok(codes.includes('OLD_WRITER_OVERWRITE'));
  assert.ok(codes.includes('CACHE_REVISION_ISOLATION'));
});

test('all documented release checks remain mandatory', () => {
  for (const check of ['historical contract/run replay', 'support matrix generated only from admitted evidence-backed profiles']) {
    const x = clone(plan);
    x.required_release_checks = x.required_release_checks.filter((item) => item !== check);
    assert.ok(verifyPlan(x).errors.some((e) => e.code === 'REQUIRED_RELEASE_CHECK_MISSING'), check);
  }
});

test('syntactically valid fake evidence digests cannot satisfy a release check', () => {
  const x = clone(plan);
  const item = x.release_check_results.find((entry) => entry.id === 'bskel npm run test:pack');
  item.observed_state = 'PASS';
  item.evidence_refs = ['sha256:' + '0'.repeat(64)];
  assert.ok(verifyPlan(x).errors.some((e) => e.code === 'RELEASE_CHECK_EVIDENCE_NOT_FOUND'));
  assert.ok(releasePlanBlockers(x, inventory, evidenceStore).includes('RELEASE_CHECKS_NOT_COMPLETE'));
});

test('evidence resolver recomputes bytes and binds check plus exact release heads', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-release-evidence-'));
  try {
    const artifactDir = path.join(temp, 'evidence-artifacts');
    fs.mkdirSync(artifactDir);
    const heads = Object.fromEntries(inventory.repositories.map((repo) => [repo.role, repo.head_sha]));
    const artifact = {
      schema: 'bskel.scale-release-evidence/1',
      check_id: 'bskel npm run test:pack',
      outcome: 'PASS',
      observed_at: '2026-09-27T00:00:00Z',
      release_heads: heads,
      details: { command: 'npm run test:pack', exit_code: 0 },
    };
    const bytes = JSON.stringify(artifact, null, 2) + '\n';
    const ref = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(artifactDir, 'bskel-pack.json'), bytes);
    fs.writeFileSync(path.join(temp, 'evidence-manifest.json'), JSON.stringify({
      schema: 'bskel.scale-release-evidence-manifest/1',
      entries: [{ ref, path: 'evidence-artifacts/bskel-pack.json' }],
    }, null, 2) + '\n');

    const store = loadEvidenceStore(path.join(temp, 'evidence-manifest.json'));
    assert.equal(store.ok, true, JSON.stringify(store.errors));

    const x = clone(plan);
    const item = x.release_check_results.find((entry) => entry.id === artifact.check_id);
    item.observed_state = 'PASS';
    item.evidence_refs = [ref];
    const errors = verifyReleasePlan(x, inventory, store).errors;
    assert.equal(errors.some((e) => e.code.startsWith('RELEASE_CHECK_EVIDENCE_')), false, JSON.stringify(errors));

    const wrongContext = { ...artifact, release_heads: { ...heads, beval: '0'.repeat(40) } };
    const wrongBytes = JSON.stringify(wrongContext, null, 2) + '\n';
    const wrongRef = 'sha256:' + crypto.createHash('sha256').update(wrongBytes).digest('hex');
    fs.writeFileSync(path.join(artifactDir, 'wrong-context.json'), wrongBytes);
    fs.writeFileSync(path.join(temp, 'wrong-manifest.json'), JSON.stringify({
      schema: 'bskel.scale-release-evidence-manifest/1',
      entries: [{ ref: wrongRef, path: 'evidence-artifacts/wrong-context.json' }],
    }, null, 2) + '\n');
    const wrongStore = loadEvidenceStore(path.join(temp, 'wrong-manifest.json'));
    const y = clone(plan);
    const wrongItem = y.release_check_results.find((entry) => entry.id === artifact.check_id);
    wrongItem.observed_state = 'PASS';
    wrongItem.evidence_refs = [wrongRef];
    assert.ok(verifyReleasePlan(y, inventory, wrongStore).errors.some((e) => e.code === 'RELEASE_CHECK_EVIDENCE_CONTEXT_MISMATCH'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('legacy HTTP identity stays authoritative during additive T01 shipping', () => {
  const x = clone(inventory);
  x.invariants.legacy_http_identity_authoritative = false;
  assert.ok(verifyCompatibilityInventory(x).errors.some((e) => e.code === 'LEGACY_IDENTITY_AUTHORITY'));
});
