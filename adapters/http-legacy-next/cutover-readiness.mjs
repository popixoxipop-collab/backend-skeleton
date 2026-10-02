import { LEGACY_HTTP_ADAPTER_IDS } from './baselines.mjs';

export const T11_CUTOVER_READINESS_SCHEMA = 'bskel.internal.t11-cutover-readiness/0';

const CHECKS = Object.freeze([
  ['ownership_scope_clean', 'ownership-scope-not-clean'],
  ['legacy_baseline_pinned', 'legacy-baseline-not-pinned'],
  ['lossless_bridge_verified', 'lossless-bridge-not-verified'],
  ['semantic_parity_verified', 'semantic-parity-not-verified'],
  ['pinned_corpus_verified', 'pinned-corpus-not-verified'],
  ['exact_head_ci_green', 'exact-head-ci-not-green'],
  ['identity_interface_frozen', 'identity-interface-not-frozen'],
  ['capability_interface_frozen', 'capability-interface-not-frozen'],
  ['independent_review_accepted', 'independent-review-not-accepted'],
  ['nested_test_discovery_integrated', 'nested-test-discovery-not-integrated'],
]);

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}

// T11-only migration readiness. This is intentionally NOT a T03 support certification and never
// mutates stable dispatch. T00/T23 still own the actual integration/cutover operation.
export function evaluateLegacyHttpCutoverReadiness({ adapterId, checks } = {}) {
  if (!LEGACY_HTTP_ADAPTER_IDS.includes(adapterId)) {
    throw new TypeError(`adapterId must be one of T11 legacy adapters: ${LEGACY_HTTP_ADAPTER_IDS.join(', ')}`);
  }
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new TypeError('checks must be an object');
  }

  const known = new Set(CHECKS.map(([name]) => name));
  const extra = Object.keys(checks).filter((name) => !known.has(name));
  if (extra.length > 0) throw new TypeError(`unknown T11 cutover checks: ${extra.sort().join(', ')}`);

  const normalized = {};
  const blockers = [];
  for (const [name, blocker] of CHECKS) {
    const value = requireBoolean(checks[name], `checks.${name}`);
    normalized[name] = value;
    if (!value) blockers.push(blocker);
  }

  return Object.freeze({
    schema: T11_CUTOVER_READINESS_SCHEMA,
    adapter_id: adapterId,
    checks: Object.freeze(normalized),
    ready_for_t00_integration: blockers.length === 0,
    // This module is analysis-only. Even a fully-ready result cannot write stable dispatch.
    apply_allowed: false,
    blockers: Object.freeze(blockers),
    notes: Object.freeze([
      'T11 readiness is migration-specific and is not a framework support/certification record.',
      'Actual stable dispatch/schema/package changes require T00/T23 integration ownership.',
      'A missing gate remains blocked; no waiver or name-based repair is performed here.',
    ]),
  });
}
