import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../release-policy.mjs';
import {
  IDENTITY_PACK_SHA256, MANIFEST_PATH, WAIVER,
  accept, clone, codes, fileRef, inventory, plan, repoOf, tempRoot, waiverRef,
} from './policy-fixtures.mjs';

const verify = (inv, root) => policy.verifyCompatibilityInventory(inv, { repoRoot: root });
const refCodes = (result, key) => result.errors.filter((e) => e.key === key && /^PROMOTION_EVIDENCE_(REF|WAIVER)_/.test(e.code)).map((e) => e.code);
const FIELDS = ['id', 'approved_by', 'approved_on', 'scope', 'reason'];

test('a complete waiver accepts its entry, clears its blocker and is surfaced as waived evidence', (t) => {
  const root = tempRoot(t);
  const result = verify(accept(inventory, 't19_03', waiverRef()), root);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.observed_blockers, ['TRUST_POLICY_NOT_READY']);
  assert.deepEqual(result.waived_evidence, [{ key: 't19_03', ...WAIVER }]);

  const store = policy.loadEvidenceStore(MANIFEST_PATH);
  const all = policy.verifyAll(accept(inventory, 't19_03', waiverRef()), plan, store, null, { repoRoot: root });
  assert.equal(all.ok, true, JSON.stringify([all.inventory.errors, all.release_plan.errors]));
  assert.deepEqual(all.inventory.waived_evidence, [{ key: 't19_03', ...WAIVER }]);
});

test('a waiver with a missing, blank, wrongly typed or malformed field is an error and keeps the blocker', (t) => {
  const root = tempRoot(t);
  const invalid = (ref, label, field) => {
    const result = verify(accept(inventory, 't19_03', ref), root);
    assert.equal(result.ok, false, label);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_WAIVER_INVALID'], label);
    assert.equal(result.errors.find((e) => e.code === 'PROMOTION_EVIDENCE_WAIVER_INVALID').field, field, label);
    assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'), label);
    assert.deepEqual(result.waived_evidence, [], label);
  };
  for (const field of FIELDS) {
    const missing = waiverRef();
    delete missing.waiver[field];
    invalid(missing, `${field} missing`, field);
    for (const bad of ['', '   ', 5, null, {}, []]) invalid(waiverRef({ [field]: bad }), `${field}=${JSON.stringify(bad)}`, field);
  }
  for (const date of ['2026-13-01', '2026-02-30', '2026-00-10', '20261001', '2026-9-30', '2026-10-01T00:00:00Z', 'yesterday', ' 2026-10-01', '2026-10-01 ', 20261001]) {
    invalid(waiverRef({ approved_on: date }), `approved_on=${JSON.stringify(date)}`, 'approved_on');
  }
});

test('a waiver with unknown keys or a non-object body is malformed', (t) => {
  const root = tempRoot(t);
  for (const ref of [{ kind: 'waiver', waiver: { ...WAIVER, extra: 'x' } }, { kind: 'waiver', waiver: null }, { kind: 'waiver', waiver: [] }, { kind: 'waiver', waiver: 'approved' }]) {
    const result = verify(accept(inventory, 't19_03', ref), root);
    assert.deepEqual(refCodes(result, 't19_03'), ['PROMOTION_EVIDENCE_REF_MALFORMED'], JSON.stringify(ref));
    assert.ok(result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'));
  }
});

test('a waiver on an unaccepted entry is shape-checked but waives nothing', (t) => {
  const root = tempRoot(t);
  const harmless = clone(inventory);
  harmless.promotion_evidence.t19_03.evidence_ref = waiverRef();
  const ok = verify(harmless, root);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.waived_evidence, []);
  assert.ok(ok.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'));

  const broken = clone(inventory);
  broken.promotion_evidence.t19_03.evidence_ref = waiverRef({ reason: '' });
  assert.deepEqual(refCodes(verify(broken, root), 't19_03'), ['PROMOTION_EVIDENCE_WAIVER_INVALID']);
});

test('each accepted entry needs its own waiver or file ref', (t) => {
  const root = tempRoot(t);
  const x = accept(accept(inventory, 't19_03', waiverRef()), 't20_03', undefined);
  const result = verify(x, root);
  assert.deepEqual(refCodes(result, 't19_03'), []);
  assert.deepEqual(refCodes(result, 't20_03'), ['PROMOTION_EVIDENCE_REF_REQUIRED']);
  assert.ok(result.observed_blockers.includes('TRUST_POLICY_NOT_READY'));
  assert.ok(!result.observed_blockers.includes('INDEPENDENT_QA_NOT_READY'));
});

test('bskel_pack_sha256 is renamed identity_conformance_sha256 and the pinned value is the identity pack hash', () => {
  const item = inventory.promotion_evidence.t01_06;
  assert.equal(item.identity_conformance_sha256, IDENTITY_PACK_SHA256);
  assert.equal('bskel_pack_sha256' in item, false);
  assert.equal(typeof item.evidence_ref_scope, 'string');
  assert.match(item.evidence_ref_scope, /artifact/i);
  assert.match(item.evidence_ref_scope, /23\/23/);
  assert.match(item.evidence_ref_scope, /12\/12/);
});

test('identity_conformance_sha256 is checked against the pack bytes and the old key is rejected', (t) => {
  const root = tempRoot(t);
  const mutate = (fn) => {
    const x = clone(inventory);
    fn(x.promotion_evidence.t01_06);
    return verify(x, root);
  };
  const identity = (result) => codes(result).filter((c) => c.startsWith('IDENTITY_CONFORMANCE_'));

  const mismatch = mutate((i) => { i.identity_conformance_sha256 = 'c'.repeat(64); });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(identity(mismatch), ['IDENTITY_CONFORMANCE_SHA256_MISMATCH']);

  for (const bad of ['', 'sha256:' + IDENTITY_PACK_SHA256, IDENTITY_PACK_SHA256.toUpperCase(), IDENTITY_PACK_SHA256.slice(1), 5, null]) {
    const result = mutate((i) => { i.identity_conformance_sha256 = bad; });
    assert.deepEqual(identity(result), ['IDENTITY_CONFORMANCE_SHA256_FORMAT'], JSON.stringify(bad));
  }

  const legacy = mutate((i) => { i.bskel_pack_sha256 = IDENTITY_PACK_SHA256; });
  assert.equal(legacy.ok, false);
  assert.deepEqual(legacy.errors.filter((e) => e.code === 'PROMOTION_EVIDENCE_LEGACY_KEY').map((e) => [e.key, e.field]), [['t01_06', 'bskel_pack_sha256']]);

  const renamedBack = mutate((i) => { i.bskel_pack_sha256 = i.identity_conformance_sha256; delete i.identity_conformance_sha256; });
  assert.ok(codes(renamedBack).includes('PROMOTION_EVIDENCE_LEGACY_KEY'), 'reverting the rename is an error');
});

test('the inventory schema id is bumped so the renamed key cannot be read by an older verifier', () => {
  assert.equal(inventory.schema, 'bskel.scale-release-compatibility/3');
  const old = clone(inventory);
  old.schema = 'bskel.scale-release-compatibility/2';
  assert.ok(codes(policy.verifyCompatibilityInventory(old)).includes('INVENTORY_SCHEMA'));
});

test('ci_run must be a positive safe integer offline too, so offline and online agree on what a run id is', () => {
  for (const bad of [-1, 0, 1.5, 2 ** 53, 1e21, NaN, '36652996212', null]) {
    const x = clone(inventory);
    repoOf(x, 'bskel').verification.ci_run = bad;
    const result = policy.verifyCompatibilityInventory(x);
    assert.deepEqual(result.errors.filter((e) => e.code === 'CI_RUN_ID').map((e) => e.role), ['bskel'], String(bad));
  }
  const fine = clone(inventory);
  repoOf(fine, 'bskel').verification.ci_run = 1;
  assert.equal(policy.verifyCompatibilityInventory(fine).ok, true);
});

test('the options argument is accepted by verifyAll and verifyReleasePlan and does not change the committed result', (t) => {
  const root = tempRoot(t);
  const store = policy.loadEvidenceStore(MANIFEST_PATH);
  const plain = policy.verifyAll(inventory, plan, store, null);
  const withRoot = policy.verifyAll(inventory, plan, store, null, { repoRoot: root });
  assert.equal(withRoot.ok, true, JSON.stringify([withRoot.inventory.errors, withRoot.release_plan.errors]));
  assert.deepEqual(withRoot, plain);
  assert.deepEqual(withRoot.inventory.waived_evidence, []);
  assert.deepEqual(policy.verifyReleasePlan(plan, inventory, store, null, { repoRoot: root }), plain.release_plan);

  const noPack = tempRoot(t, { withPack: false });
  const broken = policy.verifyAll(inventory, plan, store, null, { repoRoot: noPack });
  assert.equal(broken.ok, false, 'a root without the pinned artifact must fail the combined verification');
  assert.ok(broken.inventory.observed_blockers.includes('T01_06_NOT_ACCEPTED'));
  assert.ok(!plan.blockers.includes('T01_06_NOT_ACCEPTED'), 'the committed plan does not declare the t01_06 blocker');
  assert.ok(broken.release_plan.errors.some((e) => e.code === 'OBSERVED_BLOCKER_NOT_DECLARED' && e.blocker === 'T01_06_NOT_ACCEPTED'));
});
