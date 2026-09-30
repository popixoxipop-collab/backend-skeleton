export const CAPABILITY_STATUSES = Object.freeze(['supported','partial','unsupported','unknown','not-applicable']);
export const SUPPORT_LEVELS = Object.freeze(['discovery','contract','runtime-tested']);

const STATUS_SET = new Set(CAPABILITY_STATUSES);
const LEVEL_SET = new Set(SUPPORT_LEVELS);

function evidenceReceipt(value, capability) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('capability evidence receipt must be an object');
  if (value.verified !== true) throw new TypeError('supported capability evidence must be verified');
  if (value.capability !== capability) throw new TypeError('capability evidence scope mismatch');
  if (typeof value.evidence_id !== 'string' || !value.evidence_id) throw new TypeError('capability evidence_id is required');
  return Object.freeze({ verified: true, capability, evidence_id: value.evidence_id });
}

export function simulationCapabilityRecord({ name, status, reason = null, evidence = [] }) {
  if (typeof name !== 'string' || !name.startsWith('simulation.')) throw new TypeError('simulation capability name is invalid');
  if (!STATUS_SET.has(status)) throw new TypeError(`unsupported capability status: ${String(status)}`);
  if (!Array.isArray(evidence)) throw new TypeError('capability evidence must be an array');
  if (status === 'supported') {
    if (evidence.length === 0) throw new TypeError('supported capability requires semantically scoped verified evidence');
  } else if (typeof reason !== 'string' || !reason) {
    throw new TypeError('non-supported capability status requires a reason');
  }
  const receipts = evidence.map((item) => evidenceReceipt(item, name));
  return Object.freeze({ name, status, reason: status === 'supported' ? null : reason, evidence: Object.freeze(receipts) });
}

export function evaluateSupportLevel({ level, capabilityNames, capabilities }) {
  if (!LEVEL_SET.has(level)) throw new TypeError(`unsupported simulation support level: ${String(level)}`);
  if (!Array.isArray(capabilityNames) || capabilityNames.length === 0) throw new TypeError('capabilityNames must be a non-empty array');
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new TypeError('capabilities must be an object');
  const decisions = [];
  let ok = true;
  for (const name of capabilityNames) {
    const record = capabilities[name];
    if (!record) {
      ok = false;
      decisions.push({ name, status: 'missing', accepted: false });
      continue;
    }
    const normalized = simulationCapabilityRecord(record);
    const accepted = normalized.status === 'supported';
    if (!accepted) ok = false;
    decisions.push({ name, status: normalized.status, accepted });
  }
  return Object.freeze({ level, ok, decisions: Object.freeze(decisions) });
}

export function assertNoRuntimeCertificationFromStatic({ runtimeTested, evidenceKind }) {
  if (runtimeTested === true && evidenceKind !== 't16-runtime-plus-t19-acceptance') {
    throw new Error('runtime-tested requires exact T16 runtime execution evidence plus independent T19 acceptance');
  }
  return true;
}
