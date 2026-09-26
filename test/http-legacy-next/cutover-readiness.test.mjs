import { test } from 'node:test';
import assert from 'node:assert/strict';
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
