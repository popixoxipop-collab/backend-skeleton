// T09 evidence binding.
//
// This is a consumer of the T00-04A-approved T01 ArtifactRef semantics and the independently
// reviewed T16 immutable runtime binding/evidence core. It is not a replacement stable wire.
//
// Source/OpenAPI are bound only after their exact bytes match sbf.artifact-ref/1.
// Runtime-backed readiness additionally requires a canonical beval.runtime-binding/1,
// a canonical beval.runtime-evidence-pair/1, exact profile/attempt/contract/case hashes,
// and exact source/OpenAPI artifact digests recorded in the T16 binding artifacts map.

import {
  ROUTE_PROMOTION_FIELDS,
} from './decision-graph.mjs';
import {
  contextBoundPromotableOperationKeys,
} from './openapi-context.mjs';
import {
  artifactEvidenceRef,
  assertArtifactRefMatches,
  assertT01ArtifactRef,
} from './artifact-ref.mjs';
import {
  assertT16RuntimeBinding,
  assertT16RuntimeEvidencePair,
  t16HashJson,
  t16RuntimeBindingHash,
} from './t16-runtime-evidence.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hashString(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function normalizeArtifactSource(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: name + '-metadata-missing' };
  }
  if (!nonEmptyString(value.repository)) {
    return { ok: false, reason: name + '-repository-missing' };
  }
  if (!nonEmptyString(value.revision)) {
    return { ok: false, reason: name + '-revision-missing' };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'bytes')) {
    return { ok: false, reason: name + '-artifact-bytes-missing' };
  }
  try {
    assertT01ArtifactRef(value.artifactRef);
    assertArtifactRefMatches(value.bytes, value.artifactRef);
  } catch (error) {
    return { ok: false, reason: name + '-artifact-invalid:' + error.message };
  }

  const ref = artifactEvidenceRef(value.artifactRef);
  if (value.ref !== undefined && value.ref !== ref) {
    return { ok: false, reason: name + '-ref-does-not-match-artifact-digest' };
  }

  return {
    ok: true,
    value: {
      ref,
      artifactRef: value.artifactRef,
      repository: value.repository,
      revision: value.revision,
    },
  };
}

function sourceSpecDecision(source, openapi) {
  if (!source.ok) return { state: 'unknown', reason: source.reason };
  if (!openapi.ok) return { state: 'unknown', reason: openapi.reason };
  if (source.value.repository !== openapi.value.repository) {
    return { state: 'conflict', reason: 'source-openapi-repository-mismatch' };
  }
  if (source.value.revision !== openapi.value.revision) {
    return { state: 'conflict', reason: 'source-openapi-revision-mismatch' };
  }
  return {
    state: 'bound',
    reason: 'source-openapi-exact-artifacts-and-revision-bound',
    repository: source.value.repository,
    revision: source.value.revision,
    sourceArtifactRef: source.value.artifactRef,
    openapiArtifactRef: openapi.value.artifactRef,
  };
}

function conflict(reason) {
  return { state: 'conflict', reason };
}

function unknown(reason) {
  return { state: 'unknown', reason };
}

function normalizeRuntime(runtime) {
  if (runtime == null) return { kind: 'absent' };
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return { kind: 'invalid', reason: 'runtime-metadata-missing' };
  }

  for (const key of ['repository', 'revision']) {
    if (!nonEmptyString(runtime[key])) {
      return { kind: 'invalid', reason: 'runtime-' + key + '-missing' };
    }
  }
  for (const key of ['bindingHash', 'contractHash', 'caseRevisionHash', 'profileApprovalHash']) {
    if (!hashString(runtime[key])) {
      return { kind: 'invalid', reason: 'runtime-' + key + '-invalid' };
    }
  }
  if (!nonEmptyString(runtime.attemptNonce)) {
    return { kind: 'invalid', reason: 'runtime-attemptNonce-missing' };
  }
  if (
    !runtime.artifactNames
    || typeof runtime.artifactNames !== 'object'
    || Array.isArray(runtime.artifactNames)
    || !nonEmptyString(runtime.artifactNames.source)
    || !nonEmptyString(runtime.artifactNames.openapi)
  ) {
    return { kind: 'invalid', reason: 'runtime-artifact-names-invalid' };
  }
  if (runtime.artifactNames.source === runtime.artifactNames.openapi) {
    return { kind: 'invalid', reason: 'runtime-artifact-names-must-be-distinct' };
  }

  let normalizedBinding;
  try {
    normalizedBinding = assertT16RuntimeBinding(runtime.binding);
  } catch (error) {
    return { kind: 'invalid', reason: 'runtime-binding-invalid:' + error.message };
  }

  const actualBindingHash = t16RuntimeBindingHash(normalizedBinding);
  if (actualBindingHash !== runtime.bindingHash) {
    return { kind: 'mismatch', reason: 'runtime-binding-hash-mismatch' };
  }
  if (normalizedBinding.contract_hash !== runtime.contractHash) {
    return { kind: 'mismatch', reason: 'runtime-contract-hash-mismatch' };
  }
  if (normalizedBinding.case_revision_hash !== runtime.caseRevisionHash) {
    return { kind: 'mismatch', reason: 'runtime-case-revision-hash-mismatch' };
  }
  if (normalizedBinding.oracle_profile_approval_hash !== runtime.profileApprovalHash) {
    return { kind: 'mismatch', reason: 'runtime-profile-approval-hash-mismatch' };
  }
  if (normalizedBinding.attempt_nonce !== runtime.attemptNonce) {
    return { kind: 'mismatch', reason: 'runtime-attempt-nonce-mismatch' };
  }

  let evidence;
  try {
    evidence = assertT16RuntimeEvidencePair({
      binding: normalizedBinding,
      bindingHash: runtime.bindingHash,
      pair: runtime.evidencePair,
      oracleEvidence: runtime.oracleEvidence,
      candidateEvidence: runtime.candidateEvidence,
    });
  } catch (error) {
    const message = error.message ?? String(error);
    return {
      kind: /mismatch|does not address|wrong target|stale/i.test(message) ? 'mismatch' : 'invalid',
      reason: 'runtime-evidence-invalid:' + message,
    };
  }

  const routeObservation = runtime.candidateEvidence?.route_observation;
  const routeObservationHash = (
    routeObservation && typeof routeObservation === 'object' && !Array.isArray(routeObservation)
  ) ? t16HashJson(routeObservation) : null;

  return {
    kind: 'ok',
    value: {
      ref: actualBindingHash,
      repository: runtime.repository,
      revision: runtime.revision,
      bindingHash: actualBindingHash,
      contractHash: normalizedBinding.contract_hash,
      caseRevisionHash: normalizedBinding.case_revision_hash,
      profileApprovalHash: normalizedBinding.oracle_profile_approval_hash,
      attemptNonce: normalizedBinding.attempt_nonce,
      sourceArtifactName: runtime.artifactNames.source,
      openapiArtifactName: runtime.artifactNames.openapi,
      sourceArtifactDigest: normalizedBinding.artifacts[runtime.artifactNames.source] ?? null,
      openapiArtifactDigest: normalizedBinding.artifacts[runtime.artifactNames.openapi] ?? null,
      oracleEvidenceHash: evidence.oracleEvidenceHash,
      candidateEvidenceHash: evidence.candidateEvidenceHash,
      routeObservationHash,
    },
  };
}

function runtimeDecision(source, openapi, runtime) {
  if (runtime.kind === 'absent') {
    return { state: 'absent', reason: 'runtime-evidence-not-supplied' };
  }
  if (!source.ok) return unknown(source.reason);
  if (!openapi.ok) return unknown(openapi.reason);
  const sourceSpec = sourceSpecDecision(source, openapi);
  if (sourceSpec.state !== 'bound') return { state: sourceSpec.state, reason: sourceSpec.reason };

  if (runtime.kind === 'invalid') return unknown(runtime.reason);
  if (runtime.kind === 'mismatch') return conflict(runtime.reason);

  if (runtime.value.repository !== source.value.repository) {
    return conflict('source-runtime-repository-mismatch');
  }
  if (runtime.value.revision !== source.value.revision) {
    return conflict('source-runtime-revision-mismatch');
  }
  if (runtime.value.sourceArtifactDigest !== source.value.artifactRef.byte_sha256) {
    return conflict('runtime-source-artifact-mismatch');
  }
  if (runtime.value.openapiArtifactDigest !== openapi.value.artifactRef.byte_sha256) {
    return conflict('runtime-openapi-artifact-mismatch');
  }

  return {
    state: 'bound',
    reason: 't01-artifacts-and-t16-binding-evidence-bound',
    repository: source.value.repository,
    revision: source.value.revision,
    bindingHash: runtime.value.bindingHash,
    contractHash: runtime.value.contractHash,
    caseRevisionHash: runtime.value.caseRevisionHash,
    profileApprovalHash: runtime.value.profileApprovalHash,
    attemptNonce: runtime.value.attemptNonce,
    sourceArtifactRef: source.value.artifactRef,
    openapiArtifactRef: openapi.value.artifactRef,
    oracleEvidenceHash: runtime.value.oracleEvidenceHash,
    candidateEvidenceHash: runtime.value.candidateEvidenceHash,
  };
}

export function buildEvidenceBinding({ source, openapi, runtime = null }) {
  const sourceMeta = normalizeArtifactSource('source', source);
  const openapiMeta = normalizeArtifactSource('openapi', openapi);
  const runtimeMeta = normalizeRuntime(runtime);
  const runtimeBinding = runtimeDecision(sourceMeta, openapiMeta, runtimeMeta);

  return {
    version: 'bskel.reconciliation-evidence-binding/0-draft',
    source: sourceMeta.ok ? sourceMeta.value : null,
    openapi: openapiMeta.ok ? openapiMeta.value : null,
    runtime: runtimeMeta.kind === 'ok' ? runtimeMeta.value : null,
    sourceSpec: sourceSpecDecision(sourceMeta, openapiMeta),
    runtimeBinding,
  };
}

function graphRefs(graph) {
  const source = new Set();
  const openapi = new Set();
  for (const endpoint of graph?.endpoints ?? []) {
    for (const field of endpoint.fields ?? []) {
      for (const item of field.evidence ?? []) {
        if (item?.role === 'scan' && nonEmptyString(item.ref)) source.add(item.ref);
        if (item?.role === 'openapi' && nonEmptyString(item.ref)) openapi.add(item.ref);
      }
    }
  }
  return { source, openapi };
}

export function attachEvidenceBinding(graph, binding) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  if (!binding || binding.version !== 'bskel.reconciliation-evidence-binding/0-draft') {
    throw new TypeError('binding must be a T09 evidence binding');
  }

  const refs = graphRefs(graph);
  if (binding.source?.ref && (refs.source.size !== 1 || !refs.source.has(binding.source.ref))) {
    throw new TypeError('source binding ref does not match decision graph provenance');
  }
  if (binding.openapi?.ref && (refs.openapi.size !== 1 || !refs.openapi.has(binding.openapi.ref))) {
    throw new TypeError('OpenAPI binding ref does not match decision graph provenance');
  }

  return {
    ...graph,
    evidenceBinding: {
      attached: true,
      version: binding.version,
      sourceSpecState: binding.sourceSpec.state,
      sourceSpecReason: binding.sourceSpec.reason,
      runtimeState: binding.runtimeBinding.state,
      runtimeReason: binding.runtimeBinding.reason,
      sourceRef: binding.source?.ref ?? null,
      openapiRef: binding.openapi?.ref ?? null,
      sourceArtifactRef: binding.source?.artifactRef ?? null,
      openapiArtifactRef: binding.openapi?.artifactRef ?? null,
      runtimeBindingHash: binding.runtime?.bindingHash ?? null,
      runtimeProfileApprovalHash: binding.runtime?.profileApprovalHash ?? null,
      runtimeAttemptNonce: binding.runtime?.attemptNonce ?? null,
      runtimeOracleEvidenceHash: binding.runtime?.oracleEvidenceHash ?? null,
      runtimeCandidateEvidenceHash: binding.runtime?.candidateEvidenceHash ?? null,
    },
  };
}

export function bindingBoundPromotableOperationKeys(
  graph,
  binding,
  {
    requiredFields = ROUTE_PROMOTION_FIELDS,
    requireRuntime = false,
  } = {},
) {
  if (binding?.sourceSpec?.state !== 'bound') return [];
  if (requireRuntime && binding?.runtimeBinding?.state !== 'bound') return [];

  const attached = attachEvidenceBinding(graph, binding);
  return contextBoundPromotableOperationKeys(attached, requiredFields);
}
