// T09 runtime route observation reconciliation.
//
// This module consumes an already-produced runtime route observation. It does NOT execute the app,
// start a server, probe authorization, or define beval's runner format.
//
// Runtime route facts are accepted only when the surrounding T09 evidence binding has already
// validated the exact T16 RuntimeBinding + evidence pair and the supplied route observation is the
// exact route_observation content hashed inside the bound candidate evidence.

import { OPERATION_ID_RE, canonicalRouteShape } from '../openapi.mjs';
import { attachEvidenceBinding } from './evidence-binding.mjs';
import { hasOpenApiContextAudit } from './openapi-context.mjs';
import { t16HashJson } from './t16-runtime-evidence.mjs';

const METHODS = Object.freeze(new Set([
  'GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE',
]));
const MAX_RUNTIME_ROUTES = 10000;
const MAX_RUNTIME_ROUTE_PATH_LENGTH = 4096;

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateRoute(route, index) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return { ok: false, reason: 'runtime-route-' + index + '-not-object' };
  }
  if (!METHODS.has(route.method)) {
    return { ok: false, reason: 'runtime-route-' + index + '-invalid-method' };
  }
  if (
    !isString(route.path)
    || !route.path.startsWith('/')
    || route.path.length > MAX_RUNTIME_ROUTE_PATH_LENGTH
    || /[\0\r\n]/.test(route.path)
  ) {
    return { ok: false, reason: 'runtime-route-' + index + '-invalid-path' };
  }
  if (route.operationId != null && (!isString(route.operationId) || !OPERATION_ID_RE.test(route.operationId))) {
    return { ok: false, reason: 'runtime-route-' + index + '-invalid-operation-id' };
  }
  return {
    ok: true,
    route: {
      method: route.method,
      path: route.path,
      ...(route.operationId != null ? { operationId: route.operationId } : {}),
    },
  };
}

export function validateRuntimeRouteObservation(observation, binding) {
  if (!observation || observation.version !== 'bskel.runtime-route-observation/0-draft') {
    return { ok: false, reason: 'unsupported-runtime-observation-version' };
  }
  if (binding?.runtimeBinding?.state !== 'bound' || !binding.runtime) {
    return { ok: false, reason: 'runtime-evidence-binding-not-bound' };
  }

  for (const key of ['runtimeBindingHash', 'profileApprovalHash', 'attemptNonce']) {
    if (!isString(observation[key])) {
      return { ok: false, reason: 'runtime-observation-' + key + '-missing' };
    }
  }
  if (observation.runtimeBindingHash !== binding.runtime.bindingHash) {
    return { ok: false, reason: 'runtime-observation-binding-hash-mismatch' };
  }
  if (observation.profileApprovalHash !== binding.runtime.profileApprovalHash) {
    return { ok: false, reason: 'runtime-observation-profile-mismatch' };
  }
  if (observation.attemptNonce !== binding.runtime.attemptNonce) {
    return { ok: false, reason: 'runtime-observation-attempt-mismatch' };
  }
  if (!binding.runtime.routeObservationHash) {
    return { ok: false, reason: 'runtime-route-observation-not-bound-to-candidate-evidence' };
  }
  if (t16HashJson(observation) !== binding.runtime.routeObservationHash) {
    return { ok: false, reason: 'runtime-route-observation-content-mismatch' };
  }
  if (!['complete', 'partial'].includes(observation.completeness)) {
    return { ok: false, reason: 'runtime-observation-completeness-invalid' };
  }
  if (!Array.isArray(observation.routes)) {
    return { ok: false, reason: 'runtime-observation-routes-missing' };
  }
  if (observation.routes.length > MAX_RUNTIME_ROUTES) {
    return { ok: false, reason: 'runtime-observation-too-many-routes' };
  }

  const routes = [];
  const routeShapeKeys = new Set();
  for (const [index, route] of observation.routes.entries()) {
    const checked = validateRoute(route, index);
    if (!checked.ok) return checked;
    const routeShapeKey = checked.route.method + ' ' + canonicalRouteShape(checked.route.path);
    if (routeShapeKeys.has(routeShapeKey)) {
      return { ok: false, reason: 'duplicate-runtime-route-entry' };
    }
    routeShapeKeys.add(routeShapeKey);
    routes.push(checked.route);
  }

  routes.sort((a, b) => {
    const ak = a.method + ' ' + a.path + ' ' + (a.operationId ?? '');
    const bk = b.method + ' ' + b.path + ' ' + (b.operationId ?? '');
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return { ok: true, routes };
}

function resolvedValue(endpoint, fieldName) {
  const field = endpoint.fields?.find((entry) => entry.field === fieldName);
  return field?.state === 'resolved' ? field.value : null;
}

function routeKey(method, path) {
  return method + ' ' + canonicalRouteShape(path);
}

function addIndex(map, key, index) {
  const list = map.get(key) ?? [];
  list.push(index);
  map.set(key, list);
}

export function reconcileRuntimeRoutes({ graph, binding, observation }) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  if (!hasOpenApiContextAudit(graph)) {
    return {
      version: 'bskel.runtime-route-reconciliation/0-draft',
      state: 'blocked',
      reason: 'openapi-context-not-attached',
      endpoints: [],
      runtimeOnlyRoutes: [],
      counts: { observed: 0, conflict: 0, missing: 0, unknown: 0 },
    };
  }

  const attachedGraph = attachEvidenceBinding(graph, binding);
  const validated = validateRuntimeRouteObservation(observation, binding);
  if (!validated.ok) {
    return {
      version: 'bskel.runtime-route-reconciliation/0-draft',
      state: 'blocked',
      reason: validated.reason,
      endpoints: [],
      runtimeOnlyRoutes: [],
      counts: { observed: 0, conflict: 0, missing: 0, unknown: 0 },
    };
  }

  const byExact = new Map();
  const byOperationId = new Map();
  for (const [index, route] of validated.routes.entries()) {
    addIndex(byExact, routeKey(route.method, route.path), index);
    if (route.operationId) addIndex(byOperationId, route.operationId, index);
  }

  const claimed = new Set();
  const endpoints = [];
  for (const endpoint of attachedGraph.endpoints) {
    const operationId = resolvedValue(endpoint, 'operation.identity');
    const method = resolvedValue(endpoint, 'http.method');
    const path = resolvedValue(endpoint, 'http.path');
    if (!operationId || !method || !path) {
      endpoints.push({
        endpointKey: endpoint.endpointKey,
        state: 'unknown',
        reason: 'source-spec-route-not-resolved',
      });
      continue;
    }

    const idMatches = byOperationId.get(operationId) ?? [];
    if (idMatches.length > 1) {
      for (const index of idMatches) claimed.add(index);
      endpoints.push({
        endpointKey: endpoint.endpointKey,
        state: 'conflict',
        reason: 'duplicate-runtime-operation-id',
        expected: { operationId, method, path },
        candidates: idMatches.map((index) => validated.routes[index]),
      });
      continue;
    }

    const exact = byExact.get(routeKey(method, path)) ?? [];
    if (exact.length === 1) {
      const index = exact[0];
      const route = validated.routes[index];
      claimed.add(index);
      if (route.operationId && route.operationId !== operationId) {
        endpoints.push({
          endpointKey: endpoint.endpointKey,
          state: 'conflict',
          reason: 'runtime-operation-id-conflict',
          expected: { operationId, method, path },
          observed: route,
        });
      } else if (!route.operationId && idMatches.length === 1 && idMatches[0] !== index) {
        claimed.add(idMatches[0]);
        endpoints.push({
          endpointKey: endpoint.endpointKey,
          state: 'conflict',
          reason: 'runtime-operation-id-route-conflict',
          expected: { operationId, method, path },
          candidates: [route, validated.routes[idMatches[0]]],
        });
      } else {
        endpoints.push({
          endpointKey: endpoint.endpointKey,
          state: 'observed',
          reason: route.path === path ? 'runtime-route-exact-match' : 'runtime-route-shape-match',
          expected: { operationId, method, path },
          observed: route,
        });
      }
      continue;
    }

    if (idMatches.length === 1) {
      const index = idMatches[0];
      claimed.add(index);
      endpoints.push({
        endpointKey: endpoint.endpointKey,
        state: 'conflict',
        reason: 'runtime-route-drift',
        expected: { operationId, method, path },
        observed: validated.routes[index],
      });
      continue;
    }

    endpoints.push({
      endpointKey: endpoint.endpointKey,
      state: observation.completeness === 'complete' ? 'missing' : 'unknown',
      reason: observation.completeness === 'complete'
        ? 'runtime-route-missing-from-complete-snapshot'
        : 'runtime-observation-partial',
      expected: { operationId, method, path },
    });
  }

  const runtimeOnlyRoutes = validated.routes.filter((_, index) => !claimed.has(index));
  const counts = { observed: 0, conflict: 0, missing: 0, unknown: 0 };
  for (const endpoint of endpoints) counts[endpoint.state]++;

  return {
    version: 'bskel.runtime-route-reconciliation/0-draft',
    state: 'ready',
    sourceRef: binding.source?.ref ?? null,
    openapiRef: binding.openapi?.ref ?? null,
    runtimeBindingHash: binding.runtime?.bindingHash ?? null,
    profileApprovalHash: binding.runtime?.profileApprovalHash ?? null,
    attemptNonce: binding.runtime?.attemptNonce ?? null,
    oracleEvidenceHash: binding.runtime?.oracleEvidenceHash ?? null,
    candidateEvidenceHash: binding.runtime?.candidateEvidenceHash ?? null,
    completeness: observation.completeness,
    endpoints,
    runtimeOnlyRoutes,
    counts,
  };
}

export function runtimeObservedOperationKeys(report) {
  if (
    !report
    || report.version !== 'bskel.runtime-route-reconciliation/0-draft'
    || report.state !== 'ready'
    || !Array.isArray(report.endpoints)
  ) return [];
  return report.endpoints
    .filter((endpoint) => endpoint.state === 'observed')
    .map((endpoint) => endpoint.endpointKey);
}
