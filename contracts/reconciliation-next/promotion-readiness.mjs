// T09 promotion-readiness handoff.
//
// This is NOT the shared T03 capability policy and does not mutate stable contracts. It only
// packages T09 facts into per-endpoint readiness/blocker records that a later policy can consume.

import { attachEvidenceBinding } from './evidence-binding.mjs';
import { hasOpenApiContextAudit } from './openapi-context.mjs';

const ROUTE_FIELDS = Object.freeze([
  'operation.identity',
  'http.method',
  'http.path',
]);

function fieldMap(endpoint) {
  return new Map((endpoint.fields ?? []).map((field) => [field.field, field]));
}

function resolvedRoute(endpoint) {
  const fields = fieldMap(endpoint);
  const operationId = fields.get('operation.identity');
  const method = fields.get('http.method');
  const path = fields.get('http.path');
  if (
    operationId?.state !== 'resolved'
    || method?.state !== 'resolved'
    || path?.state !== 'resolved'
  ) return null;
  return {
    operationId: operationId.value,
    method: method.value,
    path: path.value,
  };
}

function runtimeByEndpoint(runtimeReport) {
  if (
    !runtimeReport
    || runtimeReport.version !== 'bskel.runtime-route-reconciliation/0-draft'
    || runtimeReport.state !== 'ready'
    || !Array.isArray(runtimeReport.endpoints)
  ) {
    return new Map();
  }
  return new Map(runtimeReport.endpoints.map((entry) => [entry.endpointKey, entry]));
}

function sourceSpecBlockers(endpoint, graph, binding) {
  const blockers = [];
  if (!hasOpenApiContextAudit(graph)) {
    blockers.push({ code: 'openapi-context-not-attached' });
  }
  if (binding.sourceSpec?.state !== 'bound') {
    blockers.push({
      code: 'source-spec-binding-not-bound',
      state: binding.sourceSpec?.state ?? 'unknown',
      reason: binding.sourceSpec?.reason ?? 'missing-binding-state',
    });
  }

  const fields = fieldMap(endpoint);
  for (const fieldName of ROUTE_FIELDS) {
    const field = fields.get(fieldName);
    if (field?.state !== 'resolved') {
      blockers.push({
        code: 'route-field-not-resolved',
        field: fieldName,
        state: field?.state ?? 'missing',
        reason: field?.reason ?? 'field-missing',
      });
    }
  }
  return blockers;
}

function runtimeBlocker(endpoint, runtimeReport, runtimeIndex, binding) {
  if (binding.runtimeBinding?.state !== 'bound') {
    return {
      code: 'runtime-binding-not-bound',
      state: binding.runtimeBinding?.state ?? 'unknown',
      reason: binding.runtimeBinding?.reason ?? 'missing-runtime-binding-state',
    };
  }
  if (!runtimeReport) return { code: 'runtime-report-not-supplied' };
  if (runtimeReport.version !== 'bskel.runtime-route-reconciliation/0-draft') {
    return { code: 'runtime-report-version-unsupported' };
  }
  if (runtimeReport.state !== 'ready') {
    return {
      code: 'runtime-report-not-ready',
      state: runtimeReport.state ?? 'unknown',
      reason: runtimeReport.reason ?? 'runtime-report-state-missing',
    };
  }
  if (runtimeReport.sourceRef !== binding.source?.ref) {
    return { code: 'runtime-report-source-ref-mismatch' };
  }
  if (runtimeReport.openapiRef !== binding.openapi?.ref) {
    return { code: 'runtime-report-openapi-ref-mismatch' };
  }
  if (runtimeReport.runtimeBindingHash !== binding.runtime?.bindingHash) {
    return { code: 'runtime-report-binding-hash-mismatch' };
  }
  if (runtimeReport.profileApprovalHash !== binding.runtime?.profileApprovalHash) {
    return { code: 'runtime-report-profile-mismatch' };
  }
  if (runtimeReport.attemptNonce !== binding.runtime?.attemptNonce) {
    return { code: 'runtime-report-attempt-mismatch' };
  }
  if (runtimeReport.oracleEvidenceHash !== binding.runtime?.oracleEvidenceHash) {
    return { code: 'runtime-report-oracle-evidence-mismatch' };
  }
  if (runtimeReport.candidateEvidenceHash !== binding.runtime?.candidateEvidenceHash) {
    return { code: 'runtime-report-candidate-evidence-mismatch' };
  }

  const observed = runtimeIndex.get(endpoint.endpointKey);
  if (!observed) return { code: 'runtime-endpoint-result-missing' };
  if (observed.state !== 'observed') {
    return {
      code: 'runtime-route-not-observed',
      state: observed.state,
      reason: observed.reason ?? 'runtime-route-state-missing',
    };
  }

  const expected = resolvedRoute(endpoint);
  if (!expected) return { code: 'runtime-expected-route-unavailable' };
  if (
    !observed.expected
    || observed.expected.operationId !== expected.operationId
    || observed.expected.method !== expected.method
    || observed.expected.path !== expected.path
  ) {
    return { code: 'runtime-expected-route-mismatch' };
  }
  return null;
}

export function buildPromotionReadinessReport({ graph, binding, runtimeReport = null }) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  if (!binding || binding.version !== 'bskel.reconciliation-evidence-binding/0-draft') {
    throw new TypeError('binding must be a T09 evidence binding');
  }

  // Reuses the strict provenance check; the returned graph is intentionally discarded because this
  // report is diagnostic and does not become another source of truth.
  attachEvidenceBinding(graph, binding);

  const runtimeIndex = runtimeByEndpoint(runtimeReport);
  const endpoints = graph.endpoints.map((endpoint) => {
    const sourceBlockers = sourceSpecBlockers(endpoint, graph, binding);
    const sourceSpecReady = sourceBlockers.length === 0;
    const runtimeIssue = runtimeBlocker(endpoint, runtimeReport, runtimeIndex, binding);
    const runtimeRouteReady = sourceSpecReady && runtimeIssue === null;

    return {
      endpointKey: endpoint.endpointKey,
      sourceSpecReady,
      runtimeRouteReady,
      sourceSpecBlockers: sourceBlockers,
      runtimeBlockers: runtimeIssue ? [runtimeIssue] : [],
    };
  });

  const counts = {
    endpoints: endpoints.length,
    sourceSpecReady: endpoints.filter((entry) => entry.sourceSpecReady).length,
    runtimeRouteReady: endpoints.filter((entry) => entry.runtimeRouteReady).length,
  };

  return {
    version: 'bskel.reconciliation-promotion-readiness/0-draft',
    advisoryOnly: true,
    stableCapabilityWire: false,
    endpoints,
    counts,
    verifiedEvidence: {
      sourceArtifactRef: binding.source?.artifactRef ?? null,
      openapiArtifactRef: binding.openapi?.artifactRef ?? null,
      runtime: binding.runtimeBinding?.state === 'bound' ? {
        runtimeBindingHash: binding.runtime?.bindingHash ?? null,
        contractHash: binding.runtime?.contractHash ?? null,
        caseRevisionHash: binding.runtime?.caseRevisionHash ?? null,
        profileApprovalHash: binding.runtime?.profileApprovalHash ?? null,
        attemptNonce: binding.runtime?.attemptNonce ?? null,
        oracleEvidenceHash: binding.runtime?.oracleEvidenceHash ?? null,
        candidateEvidenceHash: binding.runtime?.candidateEvidenceHash ?? null,
      } : null,
    },
  };
}
