import { bridgeLegacyHttpScan } from './bridge.mjs';
import {
  compareLegacyHttpSemanticSnapshots,
  legacyHttpSemanticDigest,
  legacyHttpSemanticSnapshot,
  LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
} from './parity.mjs';

export const T11_SHADOW_PROJECTION_SCHEMA = 'bskel.internal.t11-shadow-projection/0';

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(name + ' must be a non-empty string');
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// T11-03 pre-freeze execution shell.
//
// The projector is dependency-injected. T11 does not define T01/T02/T03 shared IR and does not
// import their draft branches. A future integration branch may adapt a frozen next IR into the
// T11 semantic snapshot shape for differential measurement.
//
// Only the legacy semantic snapshot is authoritative. Projector private/raw IR is not serialized
// or returned, preventing draft checkout paths or uncertified evidence from leaking by accident.
export function runLegacyHttpShadowProjection({
  adapter,
  report,
  projector,
  projectorId,
  projectorContract,
  maxDiffs = 100,
} = {}) {
  if (typeof projector !== 'function') throw new TypeError('projector must be a function');
  nonEmptyString(projectorId, 'projectorId');
  nonEmptyString(projectorContract, 'projectorContract');

  const bridge = bridgeLegacyHttpScan({ adapter, report });
  const legacySnapshot = legacyHttpSemanticSnapshot(report);
  const projectorInput = deepFreeze(jsonClone({
    bridge,
    legacy_semantic_snapshot: legacySnapshot,
  }));

  const projected = projector(projectorInput);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new TypeError('projector must return an object');
  }
  if (projected.then && typeof projected.then === 'function') {
    throw new TypeError('async projector results are not accepted by the synchronous T11 shadow shell');
  }
  if (projected.projector_contract !== projectorContract) {
    throw new Error('projector contract mismatch: expected "' + projectorContract + '", got "' +
      (projected.projector_contract ?? '(missing)') + '"');
  }
  if (!projected.semantic_snapshot || projected.semantic_snapshot.schema !== LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA) {
    throw new Error('projector must return semantic_snapshot with schema ' + LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA);
  }
  if (projected.semantic_snapshot.adapter !== report.adapter) {
    throw new Error('projected adapter "' + (projected.semantic_snapshot.adapter ?? '(missing)') +
      '" does not match legacy adapter "' + report.adapter + '"');
  }

  const parity = compareLegacyHttpSemanticSnapshots(
    legacySnapshot,
    projected.semantic_snapshot,
    { maxDiffs },
  );

  return deepFreeze({
    schema: T11_SHADOW_PROJECTION_SCHEMA,
    mode: 'shadow-only',
    adapter_id: report.adapter,
    projector_id: projectorId,
    projector_contract: projectorContract,
    authoritative_source: 'sbf.scan-report/2',
    legacy_semantic_sha256: legacyHttpSemanticDigest(legacySnapshot),
    projected_semantic_sha256: legacyHttpSemanticDigest(projected.semantic_snapshot),
    parity,
    promotion_allowed: false,
    notes: [
      'The stable legacy scan remains authoritative.',
      'This shell compares semantics only; it does not certify the projector or its upstream next IR.',
      'T00/T01/T02/T03/T19 integration gates remain external requirements before any cutover.',
    ],
  });
}
