import {
  createT01ArtifactRef,
} from '../../contracts/reconciliation-next/artifact-ref.mjs';
import {
  t16HashJson,
  t16RuntimeBindingHash,
} from '../../contracts/reconciliation-next/t16-runtime-evidence.mjs';

export const REPOSITORY = 'repo/example';
export const REVISION = 'abc123';
export const SOURCE_BYTES = 'source-controller-bytes\n';
export const OPENAPI_BYTES = '{"openapi":"3.1.0","paths":{}}\n';
export const CONTRACT_HASH = 'c'.repeat(64);
export const CASE_REVISION_HASH = 'a'.repeat(64);
export const PROFILE_HASH = 'b'.repeat(64);
export const RUNNER_HASH = 'd'.repeat(64);
export const POLICY_HASH = 'e'.repeat(64);
export const ATTEMPT_NONCE = '123e4567-e89b-42d3-a456-426614174000';

export function sourceInput(overrides = {}) {
  const bytes = overrides.bytes ?? SOURCE_BYTES;
  const artifactRef = overrides.artifactRef ?? createT01ArtifactRef(bytes, {
    family: 'source.snapshot',
    version: '1',
    media_type: 'text/plain',
  });
  return {
    repository: overrides.repository ?? REPOSITORY,
    revision: overrides.revision ?? REVISION,
    artifactRef,
    bytes,
    ...(overrides.ref !== undefined ? { ref: overrides.ref } : {}),
  };
}

export function openapiInput(overrides = {}) {
  const bytes = overrides.bytes ?? OPENAPI_BYTES;
  const artifactRef = overrides.artifactRef ?? createT01ArtifactRef(bytes, {
    family: 'openapi',
    version: '3.1.0',
    media_type: 'application/json',
  });
  return {
    repository: overrides.repository ?? REPOSITORY,
    revision: overrides.revision ?? REVISION,
    artifactRef,
    bytes,
    ...(overrides.ref !== undefined ? { ref: overrides.ref } : {}),
  };
}

export function routeObservation(routes = [
  { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
], completeness = 'complete', {
  runtimeBindingHash,
  profileApprovalHash = PROFILE_HASH,
  attemptNonce = ATTEMPT_NONCE,
} = {}) {
  return {
    version: 'bskel.runtime-route-observation/0-draft',
    runtimeBindingHash,
    profileApprovalHash,
    attemptNonce,
    completeness,
    routes,
  };
}

export function runtimeInput({
  source = sourceInput(),
  openapi = openapiInput(),
  repository = REPOSITORY,
  revision = REVISION,
  contractHash = CONTRACT_HASH,
  caseRevisionHash = CASE_REVISION_HASH,
  profileApprovalHash = PROFILE_HASH,
  attemptNonce = ATTEMPT_NONCE,
  sourceArtifactName = 'source-input',
  openapiArtifactName = 'openapi-input',
  routeRoutes,
  completeness = 'complete',
  mutateBinding = null,
  mutatePair = null,
  mutateOracleEvidence = null,
  mutateCandidateEvidence = null,
  runtimeOverrides = {},
} = {}) {
  let binding = {
    runtime_binding: 'beval.runtime-binding/1',
    run_id: 'run-t09-fixture',
    case_revision_hash: caseRevisionHash,
    oracle_profile_approval_hash: profileApprovalHash,
    contract_hash: contractHash,
    flow_hash: null,
    config_hash: null,
    candidate_hash: '1'.repeat(64),
    original_hash: '2'.repeat(64),
    runner_implementation_hash: RUNNER_HASH,
    runtime_execution_policy_hash: POLICY_HASH,
    artifacts: {
      [sourceArtifactName]: source.artifactRef.byte_sha256,
      [openapiArtifactName]: openapi.artifactRef.byte_sha256,
    },
    attempt_nonce: attemptNonce,
  };
  if (mutateBinding) binding = mutateBinding(structuredClone(binding));
  const bindingHash = t16RuntimeBindingHash(binding);

  const observation = routeObservation(routeRoutes, completeness, {
    runtimeBindingHash: bindingHash,
    profileApprovalHash,
    attemptNonce,
  });

  let oracleEvidence = {
    target: 'oracle',
    contract_hash: contractHash,
    result: { ok: true },
  };
  let candidateEvidence = {
    target: 'candidate',
    contract_hash: contractHash,
    route_observation: observation,
  };
  if (mutateOracleEvidence) oracleEvidence = mutateOracleEvidence(structuredClone(oracleEvidence));
  if (mutateCandidateEvidence) candidateEvidence = mutateCandidateEvidence(structuredClone(candidateEvidence));

  let evidencePair = {
    runtime_evidence_pair: 'beval.runtime-evidence-pair/1',
    family: 'http',
    runtime_binding_hash: bindingHash,
    attempt_nonce: attemptNonce,
    oracle_evidence_hash: t16HashJson(oracleEvidence),
    candidate_evidence_hash: t16HashJson(candidateEvidence),
  };
  if (mutatePair) evidencePair = mutatePair(structuredClone(evidencePair));

  return {
    runtime: {
      repository,
      revision,
      binding,
      bindingHash,
      evidencePair,
      oracleEvidence,
      candidateEvidence,
      contractHash,
      caseRevisionHash,
      profileApprovalHash,
      attemptNonce,
      artifactNames: {
        source: sourceArtifactName,
        openapi: openapiArtifactName,
      },
      ...runtimeOverrides,
    },
    observation,
  };
}
