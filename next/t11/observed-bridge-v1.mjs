// T11-02 opt-in product bridge: report-presence evidence bound to the
// existing lossless legacy compatibility bridge and semantic snapshot.
// No change to sbf.scan-report/2 legacy source, default scanner registry,
// historical baselines, route support or promotion. This preserves an explicit
// distinction between data not reported and data observed to be empty.
import { bridgeLegacyHttpScan } from '../../adapters/http-legacy-next/bridge.mjs';
import {
  legacyHttpSemanticSnapshot, legacyHttpSemanticDigest,
} from '../../adapters/http-legacy-next/parity.mjs';
import { observeLegacyScanReport } from './report-observation-v1.mjs';

export const T11_OBSERVED_BRIDGE_V1 = 'bskel.t11-observed-http-bridge/1';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const member of Object.values(value)) deepFreeze(member);
  return value;
}

/**
 * Opt-in T11-02 report envelope for T00/T01/T02/T03 consumers to inspect.
 * The observation is derived from the original report FIRST: the existing
 * bridge JSON clone drops explicit undefined and cannot be treated as
 * authoritative presence information.
 *
 * @param {object} arg
 * @param {object} arg.adapter a known sbf.adapter/2 legacy HTTP descriptor
 * @param {object} arg.report the original sbf.scan-report/2 input
 * @param {string} [arg.root] optional canonical absolute source root
 * @returns {object} report-presence evidence paired with legacy snapshot
 */
export function bridgeLegacyHttpWithObservation({
  adapter, report, root,
} = {}) {
  const originalObservation = observeLegacyScanReport(report);
  // Existing JSON-clone/semantic projection paths dereference their input.
  // Reject any accessor in fields we inspect BEFORE handing the report to
  // that legacy path, so untrusted getters cannot execute as a side effect of
  // this new opt-in bridge.
  const topStates = Object.values(originalObservation.fields);
  const nestedStates = originalObservation.modules.flatMap(
    m => Object.values(m.fields),
  );
  if ([...topStates, ...nestedStates].some(
    field => field.state === 'accessor_unsupported',
  )) {
    throw new TypeError('T11_REPORT_ACCESSOR_UNSUPPORTED');
  }
  // Own-only presence evidence and legacy semantic projection must agree
  // about source ownership. An inherited legacy field would be ignored by
  // observation but still dereferenced by the original semantic projector.
  for (const key of Object.keys(originalObservation.fields)) {
    if (!Object.hasOwn(report, key) && key in report) {
      throw new TypeError('T11_REPORT_INHERITED_FIELD_UNSUPPORTED');
    }
  }
  const modulesDescriptor = Object.getOwnPropertyDescriptor(report, 'related_modules');
  const modules = Array.isArray(modulesDescriptor?.value)
    ? modulesDescriptor.value : [];
  for (const module of modules) {
    if (!module || typeof module !== 'object') continue;
    for (const key of ['module', 'controllers', 'entities', 'enums', 'dtos']) {
      if (!Object.hasOwn(module, key) && key in module) {
        throw new TypeError('T11_MODULE_INHERITED_FIELD_UNSUPPORTED');
      }
    }
  }
  const bridge = bridgeLegacyHttpScan({ adapter, report });
  const semanticSnapshot = legacyHttpSemanticSnapshot(report, { root });
  if (bridge.source_adapter.id !== semanticSnapshot.adapter) {
    throw new TypeError('T11_BRIDGE_ADAPTER_MISMATCH');
  }
  const semanticDigest = legacyHttpSemanticDigest(semanticSnapshot);

  return deepFreeze({
    schema: T11_OBSERVED_BRIDGE_V1,
    mode: 'compatibility-and-presence-only',
    source_adapter_id: bridge.source_adapter.id,
    source_scan_schema: 'sbf.scan-report/2',
    legacy_bridge: bridge,
    legacy_semantic_sha256: semanticDigest,
    report_observation: originalObservation,
    report_observation_sha256: originalObservation.observationSha256,
    consumer_presence_available: true,
    // Reporting a field and proving that every route is found are
    // fundamentally different claims.
    runtime_certified: false,
    promotion_allowed: false,
    source_authorized: false,
    notes: Object.freeze([
      'Legacy sbf.scan-report/2 remains authoritative and unchanged.',
      'An observed-empty list is not the same as a section not reported.',
      'This wrapper is opt-in and does not upgrade supported capabilities.',
      'Independent reviewer and T00/T23 admission remain external gates.',
    ]),
  });
}
