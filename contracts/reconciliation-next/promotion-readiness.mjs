// T09 promotion-readiness handoff.
//
// This is NOT the shared T03 capability policy and does not mutate stable contracts. It only
// packages T09 facts into per-endpoint readiness/blocker records that a later policy can consume.

import { attachEvidenceBinding } from './evidence-binding.mjs';

const ROUTE_FIELDS = Object.freeze([
  'operation.identity',
  'http.method',
  'http.path',
]);

function fieldMap(endpoint) {
  return new Map((endpoint.fields ?? []).map((field) => [field.field, field]));
}

function runtimeByEndpoint(runtimeReport) {
  if (!runtimeReport || runtimeReport.state !== 'ready' || !Array.isArray(runtimeReport.endpoints)) {
    return new Map();
  }
  return new Map(runtimeReport.endpoints.map((entry) => [entry.endpointKey, entry]));
}

function sourceSpecBlockers(endpoint, graph, binding) {
  const blockers = [];
  if (graph.openApiContext?.attached !== true) {
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

function runtimeBlocker(endpointKey, runtimeReport, runtimeIndex, binding) {
  if (binding.runtimeBinding?.state !== 'bound') {
    return {
      code: 'runtime-binding-not-bound',
      state: binding.runtimeBinding?.state ?? 'unknown',
      reason: binding.runtimeBinding?.reason ?? 'missing-runtime-binding-state',
    };
  }
  if (!runtimeReport) return { code: 'runtime-report-not-supplied' };
  if (runtimeReport.state !== 'ready') {
    return {
      code: 'runtime-report-not-ready',
      state: runtimeReport.state ?? 'unknown',
      reason: runtimeReport.reason ?? 'runtime-report-state-missing',
    };
  }
  if (runtimeReport.runtimeRef !== binding.runtime?.ref) {
    return { code: 'runtime-report-ref-mismatch' };
  }

  const observed = runtimeIndex.get(endpointKey);
  if (!observed) return { code: 'runtime-endpoint-result-missing' };
  if (observed.state !== 'observed') {
    return {
      code: 'runtime-route-not-observed',
      state: observed.state,
      reason: observed.reason ?? 'runtime-route-state-missing',
    };
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
    const runtimeIssue = runtimeBlocker(endpoint.endpointKey, runtimeReport, runtimeIndex, binding);
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
    endpoints,
    counts,
  };
}
