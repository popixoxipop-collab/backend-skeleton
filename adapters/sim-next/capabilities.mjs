import {
  CAPABILITY_STATUSES as T03_CAPABILITY_STATUSES,
  capabilityRecord,
} from '../../scanners/capability-next/records.mjs';
import { evaluateCapabilityPolicy } from '../../scanners/capability-next/policy.mjs';
import { runtimeCertificationBlockedReason } from '../../scanners/capability-next/evidence.mjs';

export const CAPABILITY_STATUSES = T03_CAPABILITY_STATUSES;
export const SUPPORT_LEVELS = Object.freeze(['discovery','contract','runtime-tested']);

const LEVEL_SET = new Set(SUPPORT_LEVELS);

export function simulationCapabilityRecord({
  name,
  status,
  reason = null,
  evidence = [],
} = {}) {
  if (typeof name !== 'string' || !name.startsWith('simulation.')) {
    throw new TypeError('simulation capability name is invalid');
  }

  // Delegate all authority semantics to the reviewed T03 capability boundary.
  // In particular, supported requires opaque verifier-issued T03 evidence receipts;
  // a caller-created plain object can never mint authority here.
  return capabilityRecord({
    name,
    status,
    reason,
    evidence,
    source: 'simulation-next',
  });
}

export function evaluateSupportLevel({
  level,
  capabilityNames,
  capabilities,
} = {}) {
  if (!LEVEL_SET.has(level)) {
    throw new TypeError(`unsupported simulation support level: ${String(level)}`);
  }
  if (!Array.isArray(capabilityNames) || capabilityNames.length === 0 ||
      capabilityNames.some((name) => typeof name !== 'string' || !name.startsWith('simulation.'))) {
    throw new TypeError('capabilityNames must be a non-empty array of simulation.* capability names');
  }

  for (const name of capabilityNames) {
    const record = capabilities?.[name];
    if (record?.status === 'supported' &&
        (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0)) {
      throw new TypeError(
        `supported simulation capability ${name} requires verifier-issued evidence; legacy boolean bridges do not authorize simulation.*`,
      );
    }
  }

  const evaluation = evaluateCapabilityPolicy({
    capabilities,
    requirements: capabilityNames.map((capability) => ({
      capability,
      acceptedStatuses: ['supported'],
    })),
    policyId: `simulation-${level}`,
  });

  return Object.freeze({
    level,
    ok: evaluation.allowed,
    decisions: Object.freeze(evaluation.decisions.map((decision) => Object.freeze({
      name: decision.capability,
      status: decision.status,
      accepted: decision.allowed,
    }))),
  });
}

export function assertNoRuntimeCertificationFromStatic({
  runtimeTested,
} = {}) {
  if (typeof runtimeTested !== 'boolean') {
    throw new TypeError('runtimeTested must be boolean');
  }
  if (runtimeTested) {
    // T03 intentionally blocks runtime-tested until a reviewed verifier exists for
    // exact T16 runtime execution plus independent T19 acceptance. No string,
    // boolean, or SIM-local receipt can bypass that boundary.
    throw new Error(runtimeCertificationBlockedReason());
  }
  return true;
}
