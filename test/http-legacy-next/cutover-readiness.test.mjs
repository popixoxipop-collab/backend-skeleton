import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_HTTP_ADAPTER_IDS } from '../../adapters/http-legacy-next/baselines.mjs';
import {
  T11_CUTOVER_READINESS_SCHEMA,
  evaluateLegacyHttpCutoverReadiness,
} from '../../adapters/http-legacy-next/cutover-readiness.mjs';

function all(value = true) {
  return {
    ownership_scope_clean: value,
    legacy_baseline_pinned: value,
    lossless_bridge_verified: value,
    semantic_parity_verified: value,
    pinned_corpus_verified: value,
    exact_head_ci_green: value,
    identity_interface_frozen: value,
    capability_interface_frozen: value,
    independent_review_accepted: value,
    nested_test_discovery_integrated: value,
  };
}

test('T11-06 readiness never grants apply permission even when every migration gate is true', () => {
  const result = evaluateLegacyHttpCutoverReadiness({ adapterId: 'java-spring', checks: all(true) });
  assert.equal(result.schema, T11_CUTOVER_READINESS_SCHEMA);
  assert.equal(result.ready_for_t00_integration, true);
  assert.equal(result.apply_allowed, false);
  assert.deepEqual(result.blockers, []);
});

test('T11-06 readiness names each missing gate instead of collapsing failures', () => {
  const checks = all(true);
  checks.exact_head_ci_green = false;
  checks.independent_review_accepted = false;
  checks.nested_test_discovery_integrated = false;

  const result = evaluateLegacyHttpCutoverReadiness({ adapterId: 'python-fastapi', checks });
  assert.equal(result.ready_for_t00_integration, false);
  assert.equal(result.apply_allowed, false);
  assert.deepEqual(result.blockers, [
    'exact-head-ci-not-green',
    'independent-review-not-accepted',
    'nested-test-discovery-not-integrated',
  ]);
});

test('T11-06 readiness remains per-adapter and rejects non-legacy adapters', () => {
  assert.throws(
    () => evaluateLegacyHttpCutoverReadiness({ adapterId: 'typescript-nestjs', checks: all(true) }),
    /T11 legacy adapters/,
  );
});

test('T11-06 readiness rejects missing, non-boolean, or invented gates fail-closed', () => {
  const missing = all(true);
  delete missing.semantic_parity_verified;
  assert.throws(
    () => evaluateLegacyHttpCutoverReadiness({ adapterId: 'ruby-rails', checks: missing }),
    /semantic_parity_verified must be boolean/,
  );

  const wrong = all(true);
  wrong.pinned_corpus_verified = 'yes';
  assert.throws(
    () => evaluateLegacyHttpCutoverReadiness({ adapterId: 'ruby-rails', checks: wrong }),
    /pinned_corpus_verified must be boolean/,
  );

  assert.throws(
    () => evaluateLegacyHttpCutoverReadiness({
      adapterId: 'ruby-rails',
      checks: { ...all(true), magic_override: true },
    }),
    /unknown T11 cutover checks/,
  );
});

test('T11-06 current pre-freeze shape is explicitly blocked without fabricating missing approvals', () => {
  const current = all(true);
  current.exact_head_ci_green = false; // current head CI is checked externally, not assumed.
  current.identity_interface_frozen = false;
  current.capability_interface_frozen = false;
  current.independent_review_accepted = false;
  current.nested_test_discovery_integrated = false;

  const result = evaluateLegacyHttpCutoverReadiness({ adapterId: 'javascript-express', checks: current });
  assert.equal(result.ready_for_t00_integration, false);
  assert.equal(result.apply_allowed, false);
  assert.ok(result.blockers.includes('identity-interface-not-frozen'));
  assert.ok(result.blockers.includes('capability-interface-not-frozen'));
  assert.ok(result.blockers.includes('nested-test-discovery-not-integrated'));
});

const BLOCKER_BY_GATE = {
  ownership_scope_clean: 'ownership-scope-not-clean',
  legacy_baseline_pinned: 'legacy-baseline-not-pinned',
  lossless_bridge_verified: 'lossless-bridge-not-verified',
  semantic_parity_verified: 'semantic-parity-not-verified',
  pinned_corpus_verified: 'pinned-corpus-not-verified',
  exact_head_ci_green: 'exact-head-ci-not-green',
  identity_interface_frozen: 'identity-interface-not-frozen',
  capability_interface_frozen: 'capability-interface-not-frozen',
  independent_review_accepted: 'independent-review-not-accepted',
  nested_test_discovery_integrated: 'nested-test-discovery-not-integrated',
};
const GATES = Object.keys(BLOCKER_BY_GATE);
const evaluate = (checks, adapterId = 'java-spring') => evaluateLegacyHttpCutoverReadiness({ adapterId, checks });

test('T11-06 each single missing gate blocks readiness and is the only blocker named', () => {
  for (const gate of GATES) {
    const checks = all(true);
    checks[gate] = false;
    const result = evaluate(checks);
    assert.equal(result.ready_for_t00_integration, false, gate);
    assert.deepEqual(result.blockers, [BLOCKER_BY_GATE[gate]], gate);
    assert.equal(result.checks[gate], false, gate);
    assert.equal(result.apply_allowed, false, gate);
  }
});

test('T11-06 with every gate false all ten blockers are named in declaration order', () => {
  const result = evaluate(all(false));
  assert.equal(result.ready_for_t00_integration, false);
  assert.deepEqual(result.blockers, GATES.map((gate) => BLOCKER_BY_GATE[gate]));
  assert.deepEqual(result.checks, all(false));
});

test('T11-06 every gate rejects every non-boolean value, including the strings "true" and "false"', () => {
  for (const gate of GATES) {
    for (const bad of ['true', 'false', 1, 0, null, undefined, {}, []]) {
      const checks = all(true);
      checks[gate] = bad;
      assert.throws(() => evaluate(checks), new RegExp(`checks\\.${gate} must be boolean`), `${gate}=${String(bad)}`);
    }
  }
});

test('T11-06 checks must be a plain object', () => {
  for (const bad of [undefined, null, [], [true], 'checks', 5, true]) {
    assert.throws(() => evaluate(bad), /checks must be an object/, String(bad));
  }
  assert.throws(() => evaluateLegacyHttpCutoverReadiness(), /T11 legacy adapters/);
});

test('T11-06 a gate inherited from a prototype is not an answer', () => {
  const inheritedAll = Object.create(all(true));
  assert.throws(() => evaluate(inheritedAll), /checks\.ownership_scope_clean must be boolean/);

  const { exact_head_ci_green: _omitted, ...own } = all(true);
  const oneInherited = Object.assign(Object.create({ exact_head_ci_green: true }), own);
  assert.throws(() => evaluate(oneInherited), /checks\.exact_head_ci_green must be boolean/);
});

test('T11-06 unknown gates are all named, sorted, and rejected', () => {
  assert.throws(
    () => evaluate({ ...all(true), zeta: true, alpha: false }),
    /unknown T11 cutover checks: alpha, zeta$/,
  );
});

test('T11-06 the verdict names its adapter and cannot be edited by the caller', () => {
  for (const id of LEGACY_HTTP_ADAPTER_IDS) {
    assert.equal(evaluate(all(true), id).adapter_id, id);
  }

  const input = all(true);
  const result = evaluate(input);
  for (const part of [result, result.checks, result.blockers, result.notes]) {
    assert.ok(Object.isFrozen(part));
  }
  assert.throws(() => { result.apply_allowed = true; }, TypeError);
  assert.throws(() => { result.ready_for_t00_integration = false; }, TypeError);
  assert.throws(() => { result.checks.exact_head_ci_green = false; }, TypeError);
  assert.throws(() => { result.blockers.push('x'); }, TypeError);
  assert.throws(() => { result.notes.push('x'); }, TypeError);

  input.exact_head_ci_green = false;
  assert.equal(result.checks.exact_head_ci_green, true, 'the verdict is a copy of the answers, not the caller object');
  assert.equal(result.apply_allowed, false);
});
