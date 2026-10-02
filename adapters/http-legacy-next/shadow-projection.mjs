import { bridgeLegacyHttpScan } from './bridge.mjs';
import {
  compareLegacyHttpSemanticSnapshots,
  legacyHttpSemanticDigest,
  legacyHttpSemanticSnapshot,
  LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA,
} from './parity.mjs';

export const T11_SHADOW_PROJECTION_SCHEMA = 'bskel.internal.t11-shadow-projection/0';

const ASYNC_PROJECTOR_MESSAGE = 'async projector results are not accepted by the synchronous T11 shadow shell';

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

// An async projector returns a promise that may reject later. The caller already receives a
// TypeError for it, so the rejection is absorbed here: left unhandled, Node ends the caller's process
// with the projector's own error even though the caller caught ours.
function assertNotThenable(projected) {
  let then;
  try {
    then = projected.then;
  } catch {
    throw new TypeError(ASYNC_PROJECTOR_MESSAGE);
  }
  if (typeof then !== 'function') return;
  try {
    then.call(projected, undefined, () => {});
  } catch {
    // a then() that throws has no rejection left to observe
  }
  throw new TypeError(ASYNC_PROJECTOR_MESSAGE);
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
  // The projector may hold a reference to `report`; everything below uses values read before it runs.
  const adapterId = bridge.source_adapter.id;
  const legacySnapshot = legacyHttpSemanticSnapshot(report);
  const projectorInput = deepFreeze(jsonClone({
    bridge,
    legacy_semantic_snapshot: legacySnapshot,
  }));

  const projected = projector(projectorInput);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new TypeError('projector must return an object');
  }
  assertNotThenable(projected);
  if (projected.projector_contract !== projectorContract) {
    throw new Error('projector contract mismatch: expected "' + projectorContract + '", got "' +
      (projected.projector_contract ?? '(missing)') + '"');
  }
  if (!projected.semantic_snapshot || projected.semantic_snapshot.schema !== LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA) {
    throw new Error('projector must return semantic_snapshot with schema ' + LEGACY_HTTP_SEMANTIC_SNAPSHOT_SCHEMA);
  }
  if (projected.semantic_snapshot.adapter !== adapterId) {
    throw new Error('projected adapter "' + (projected.semantic_snapshot.adapter ?? '(missing)') +
      '" does not match legacy adapter "' + adapterId + '"');
  }

  const parity = compareLegacyHttpSemanticSnapshots(
    legacySnapshot,
    projected.semantic_snapshot,
    { maxDiffs },
  );

  return deepFreeze({
    schema: T11_SHADOW_PROJECTION_SCHEMA,
    mode: 'shadow-only',
    adapter_id: adapterId,
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
