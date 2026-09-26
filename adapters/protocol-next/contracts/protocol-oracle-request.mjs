import { createHash } from 'node:crypto';
import {
  assertProtocolContractArtifactRef,
  assertProtocolItemRefAgainstContexts,
  assertProtocolItemRefShape,
  assertT01ArtifactRefShape,
  contractContextKey,
  indexProtocolContractContexts,
} from './protocol-item-ref.mjs';

export const PROTOCOL_ORACLE_REQUEST_VERSION = '1';

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

function normalizeArtifactRef(ref, label, { protocolContract = false } = {}) {
  try {
    if (protocolContract) assertProtocolContractArtifactRef(ref);
    else assertT01ArtifactRefShape(ref);
  } catch (error) {
    throw new TypeError(label + ': ' + error.message);
  }
  return canonical(ref);
}

function normalizeAssertion(assertion) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) throw new Error('assertion must be an object');
  const id = requireString(assertion.id, 'assertion.id');
  const kind = requireString(assertion.kind, 'assertion.kind');
  if (!ASSERTION_KINDS.has(kind)) throw new Error('unsupported protocol assertion kind: ' + JSON.stringify(kind));
  let actionRef = null;
  if (assertion.action_ref != null) {
    assertProtocolItemRefShape(assertion.action_ref);
    actionRef = canonical(assertion.action_ref);
  }
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
  protocolContractRefs,
  protocolContexts,
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

  const contractRefs = (protocolContractRefs ?? [])
    .map((ref, index) => normalizeArtifactRef(ref, 'protocolContractRefs[' + index + ']', { protocolContract: true }))
    .sort((a, b) => contractContextKey(a).localeCompare(contractContextKey(b)));
  if (contractRefs.length === 0) throw new Error('protocol oracle request requires at least one protocol contract ref');
  const contractKeys = new Set(contractRefs.map(contractContextKey));
  if (contractKeys.size !== contractRefs.length) throw new Error('protocol oracle request contains duplicate protocol contract refs');
  const contextIndex = indexProtocolContractContexts(protocolContexts);
  for (const ref of contractRefs) {
    if (!contextIndex.has(contractContextKey(ref))) {
      throw new Error('protocol oracle request is missing exact contract context for bound protocol contract ref');
    }
  }
  if (contextIndex.size !== contractRefs.length) {
    throw new Error('protocol oracle request contains contract contexts that are not explicitly bound');
  }

  const normalizedAssertions = (assertions ?? []).map(normalizeAssertion).sort((a, b) => a.id.localeCompare(b.id));
  if (normalizedAssertions.length === 0) throw new Error('protocol oracle request requires at least one assertion');
  if (new Set(normalizedAssertions.map((item) => item.id)).size !== normalizedAssertions.length) {
    throw new Error('protocol oracle request contains duplicate assertion ids');
  }
  for (const assertion of normalizedAssertions) {
    if (assertion.action_ref && !contractKeys.has(contractContextKey(assertion.action_ref.contract))) {
      throw new Error('assertion ' + assertion.id + ' references a protocol contract not bound by this oracle request');
    }
    if (assertion.action_ref) assertProtocolItemRefAgainstContexts(assertion.action_ref, contextIndex);
  }

  return {
    sbf_protocol_oracle_request: PROTOCOL_ORACLE_REQUEST_VERSION,
    feature_id: featureId,
    feature_uid: featureUid,
    scenario_id: scenarioId,
    protocol_contract_refs: contractRefs,
    flow_contract_ref: flowContractRef == null ? null : normalizeArtifactRef(flowContractRef, 'flowContractRef'),
    original_ref: normalizeArtifactRef(originalRef, 'originalRef'),
    candidate_ref: normalizeArtifactRef(candidateRef, 'candidateRef'),
    runtime_profile_ref: normalizeArtifactRef(runtimeProfileRef, 'runtimeProfileRef'),
    seed: seed == null ? null : String(seed),
    assertions: normalizedAssertions,
    semantics: {
      request_is_not_runtime_evidence: true,
      ordering_does_not_imply_causation: true,
      correlation_does_not_imply_causation: true,
      executor_must_rehash_referenced_bytes: true,
      executor_must_verify_protocol_item_existence: true,
    },
  };
}

export function protocolOracleRequestDigest(request) {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}
