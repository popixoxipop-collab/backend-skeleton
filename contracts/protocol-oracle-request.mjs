import { createHash } from 'node:crypto';

export const PROTOCOL_ORACLE_REQUEST_VERSION = '1';

const SHA256 = /^[0-9a-f]{64}$/;
const ASSERTION_KINDS = new Set([
  'grpc-status',
  'graphql-result',
  'message-observed',
  'state',
  'correlation',
  'idempotency',
  'timeout',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(label + ' must be a non-empty string');
  return value;
}

function requireArtifactRef(ref, label) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(label + ' must be an artifact ref');
  requireString(ref.family, label + '.family');
  requireString(ref.version, label + '.version');
  if (!SHA256.test(ref.sha256 ?? '')) throw new Error(label + '.sha256 must be a lowercase sha256 hex digest');
  if (!Number.isInteger(ref.size_bytes) || ref.size_bytes < 0) throw new Error(label + '.size_bytes must be an integer >= 0');
  return {
    family: ref.family,
    version: ref.version,
    sha256: ref.sha256,
    size_bytes: ref.size_bytes,
  };
}

function normalizeAssertion(assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) throw new Error('assertion must be an object');
  const id = requireString(assertion.id, 'assertion.id');
  const kind = requireString(assertion.kind, 'assertion.kind');
  if (!ASSERTION_KINDS.has(kind)) throw new Error('unsupported protocol assertion kind: ' + JSON.stringify(kind));
  const actionRef = assertion.action_ref == null ? null : requireString(assertion.action_ref, 'assertion.action_ref');
  if (!Object.hasOwn(assertion, 'expect')) throw new Error('assertion ' + id + ' must declare expect');
  return {
    id,
    kind,
    action_ref: actionRef,
    expect: canonical(assertion.expect),
  };
}

export function buildProtocolOracleRequest({
  featureId,
  featureUid,
  scenarioId,
  protocolContractRef,
  flowContractRef = null,
  originalRef,
  candidateRef,
  runtimeProfileRef,
  seed = null,
  assertions,
} = {}) {
  requireString(featureId, 'featureId');
  requireString(featureUid, 'featureUid');
  requireString(scenarioId, 'scenarioId');
  const normalizedAssertions = (assertions ?? []).map(normalizeAssertion).sort((a, b) => a.id.localeCompare(b.id));
  if (normalizedAssertions.length === 0) throw new Error('protocol oracle request requires at least one assertion');
  if (new Set(normalizedAssertions.map((item) => item.id)).size !== normalizedAssertions.length) {
    throw new Error('protocol oracle request contains duplicate assertion ids');
  }

  return {
    sbf_protocol_oracle_request: PROTOCOL_ORACLE_REQUEST_VERSION,
    feature_id: featureId,
    feature_uid: featureUid,
    scenario_id: scenarioId,
    protocol_contract_ref: requireArtifactRef(protocolContractRef, 'protocolContractRef'),
    flow_contract_ref: flowContractRef == null ? null : requireArtifactRef(flowContractRef, 'flowContractRef'),
    original_ref: requireArtifactRef(originalRef, 'originalRef'),
    candidate_ref: requireArtifactRef(candidateRef, 'candidateRef'),
    runtime_profile_ref: requireArtifactRef(runtimeProfileRef, 'runtimeProfileRef'),
    seed: seed == null ? null : String(seed),
    assertions: normalizedAssertions,
    semantics: {
      request_is_not_runtime_evidence: true,
      ordering_does_not_imply_causation: true,
      correlation_does_not_imply_causation: true,
      executor_must_rehash_referenced_bytes: true,
    },
  };
}

export function protocolOracleRequestDigest(request) {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}
