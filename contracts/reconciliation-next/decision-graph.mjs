// T09 reconciliation-next shadow layer.
//
// This module intentionally does NOT replace contracts/openapi.mjs and does not write stable
// contracts. It projects the existing reconciliation result into explicit field-level decisions
// so downstream work cannot collapse conflicts/unknowns into a single matched boolean.
//
// The vocabulary is T09-local until the shared Claim/Capability interface is frozen by T01/T03.

const ENDPOINT_KINDS = Object.freeze(new Set([
  'matched', 'adopted', 'drift', 'missing', 'ambiguous', 'unresolved',
]));

export const DECISION_STATES = Object.freeze([
  'resolved', 'conflict', 'unknown', 'absent', 'skipped',
]);

export const ROUTE_PROMOTION_FIELDS = Object.freeze([
  'operation.identity', 'http.method', 'http.path',
]);

const FIELD_ORDER = Object.freeze([
  ...ROUTE_PROMOTION_FIELDS,
  'api.request.schema',
  'api.response.schema',
  'api.error.schema',
  'api.security.declared',
]);

function decision(field, state, {
  value,
  candidates,
  reason,
  authority = 'none',
  evidence = [],
} = {}) {
  if (!FIELD_ORDER.includes(field)) {
    throw new TypeError('unsupported decision field: ' + String(field));
  }
  if (!DECISION_STATES.includes(state)) {
    throw new TypeError('unsupported decision state: ' + String(state));
  }
  const out = { field, state, authority, evidence };
  if (value !== undefined) out.value = value;
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length > 0)) out.candidates = candidates;
  if (reason) out.reason = reason;
  return out;
}

function evidenceRefs(sourceRef, openapiRef) {
  const refs = [];
  if (sourceRef) refs.push({ role: 'scan', ref: sourceRef });
  if (openapiRef) refs.push({ role: 'openapi', ref: openapiRef });
  return refs;
}

function onlyRole(refs, role) {
  return refs.filter((entry) => entry.role === role);
}

function uniqueScalars(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (value == null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const key = typeof value + ':' + String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function prefixExplains(scanPath, openapiPath, prefix) {
  if (typeof scanPath !== 'string' || typeof openapiPath !== 'string') return false;
  if (scanPath === openapiPath) return true;
  const value = prefix?.value;
  if (typeof value !== 'string') return false;
  return value === '' ? scanPath === openapiPath : value + scanPath === openapiPath;
}

function sourceOperationId(result, sourceEndpoint) {
  if (sourceEndpoint?.operationIdSource === 'bskel-synthesized') return null;
  if (typeof result.operationId === 'string' && result.operationId) return result.operationId;
  if (typeof sourceEndpoint?.operationId === 'string' && sourceEndpoint.operationId) {
    return sourceEndpoint.operationId;
  }
  return null;
}

function operationDecisions(result, sourceEndpoint, prefix, refs) {
  const scanRefs = onlyRole(refs, 'scan');
  const openapiRefs = onlyRole(refs, 'openapi');
  const operationId = sourceOperationId(result, sourceEndpoint);

  switch (result.kind) {
    case 'matched':
      return [
        decision('operation.identity', 'resolved', {
          value: result.operationId,
          authority: 'scan+openapi',
          evidence: refs,
          reason: 'operation-id-match',
        }),
        decision('http.method', 'resolved', {
          value: result.verb,
          authority: 'scan+openapi',
          evidence: refs,
          reason: 'method-match',
        }),
        decision('http.path', 'resolved', {
          value: result.path,
          authority: 'reconciled',
          evidence: refs,
          reason: result.scanPath === result.path ? 'exact-path' : 'prefix-reconciled',
        }),
      ];

    case 'adopted':
      return [
        decision('operation.identity', 'resolved', {
          value: result.operationId,
          authority: 'openapi',
          evidence: openapiRefs,
          reason: 'single-route-adoption',
        }),
        decision('http.method', 'resolved', {
          value: result.verb,
          authority: 'scan+openapi',
          evidence: refs,
          reason: 'single-route-match',
        }),
        decision('http.path', 'resolved', {
          value: result.path,
          authority: 'reconciled',
          evidence: refs,
          reason: result.scanPath === result.path ? 'exact-route-adoption' : 'prefix-route-adoption',
        }),
      ];

    case 'drift': {
      const identity = operationId
        ? decision('operation.identity', 'resolved', {
            value: operationId,
            authority: 'scan+openapi',
            evidence: refs,
            reason: 'operation-id-anchor',
          })
        : decision('operation.identity', 'unknown', {
            authority: 'none',
            evidence: refs,
            reason: 'operation-id-not-retained-in-reconciliation-result',
          });

      if (result.reason === 'verb') {
        const pathIsProven = prefixExplains(result.scanPath, result.openapi?.path, prefix);
        return [
          identity,
          decision('http.method', 'conflict', {
            candidates: uniqueScalars([result.scanVerb, result.openapi?.verb]),
            authority: 'conflict',
            evidence: refs,
            reason: 'method-drift',
          }),
          pathIsProven
            ? decision('http.path', 'resolved', {
                value: result.openapi?.path,
                authority: 'reconciled',
                evidence: refs,
                reason: result.scanPath === result.openapi?.path ? 'exact-path' : 'prefix-reconciled',
              })
            : decision('http.path', 'conflict', {
                candidates: uniqueScalars([result.scanPath, result.openapi?.path]),
                authority: 'conflict',
                evidence: refs,
                reason: 'path-not-proven',
              }),
        ];
      }

      return [
        identity,
        decision('http.method', 'resolved', {
          value: result.scanVerb,
          authority: 'scan+openapi',
          evidence: refs,
          reason: 'method-match',
        }),
        decision('http.path', 'conflict', {
          candidates: uniqueScalars([result.scanPath, result.openapi?.path]),
          authority: 'conflict',
          evidence: refs,
          reason: 'path-drift',
        }),
      ];
    }

    case 'missing':
      return [
        decision('operation.identity', 'unknown', {
          candidates: uniqueScalars([operationId]),
          authority: operationId ? 'scan' : 'none',
          evidence: scanRefs,
          reason: 'operation-id-missing-from-openapi',
        }),
        decision('http.method', 'unknown', {
          candidates: uniqueScalars([result.scanVerb]),
          authority: 'scan',
          evidence: scanRefs,
          reason: 'openapi-operation-missing',
        }),
        decision('http.path', 'unknown', {
          candidates: uniqueScalars([result.scanPath]),
          authority: 'scan',
          evidence: scanRefs,
          reason: 'openapi-operation-missing',
        }),
      ];

    case 'ambiguous':
      return [
        decision('operation.identity', 'conflict', {
          candidates: uniqueScalars((result.candidates ?? []).map((entry) => entry.operationId)),
          authority: 'conflict',
          evidence: refs,
          reason: 'multiple-route-candidates',
        }),
        decision('http.method', 'resolved', {
          value: result.scanVerb,
          authority: 'scan+openapi',
          evidence: refs,
          reason: 'route-index-is-method-scoped',
        }),
        decision('http.path', 'conflict', {
          candidates: uniqueScalars([
            result.scanPath,
            ...(result.candidates ?? []).map((entry) => entry.path),
          ]),
          authority: 'conflict',
          evidence: refs,
          reason: 'multiple-route-candidates',
        }),
      ];

    case 'unresolved':
      return [
        decision('operation.identity', 'unknown', {
          candidates: uniqueScalars([operationId]),
          authority: operationId ? 'scan' : 'none',
          evidence: operationId ? scanRefs : refs,
          reason: result.reason || 'unresolved',
        }),
        decision('http.method', 'unknown', {
          candidates: uniqueScalars([result.scanVerb]),
          authority: 'scan',
          evidence: scanRefs,
          reason: result.reason || 'unresolved',
        }),
        decision('http.path', 'unknown', {
          candidates: uniqueScalars([result.scanPath]),
          authority: 'scan',
          evidence: scanRefs,
          reason: result.reason || 'unresolved',
        }),
      ];

    default:
      throw new TypeError('unsupported reconciliation kind: ' + String(result.kind));
  }
}

function schemaDecision(field, result, { valueKey, unresolvedKey }, refs, schemaProjection) {
  const openapiRefs = onlyRole(refs, 'openapi');

  if (result[valueKey] !== undefined) {
    return decision(field, 'resolved', {
      value: result[valueKey],
      authority: 'openapi',
      evidence: openapiRefs,
      reason: 'projected-from-safely-reconciled-openapi',
    });
  }
  if (result[unresolvedKey]) {
    return decision(field, 'unknown', {
      authority: 'openapi',
      evidence: openapiRefs,
      reason: result[unresolvedKey],
    });
  }
  if (schemaProjection?.enabled === false) {
    return decision(field, 'skipped', {
      authority: 'openapi',
      evidence: openapiRefs,
      reason: schemaProjection.reason || 'schema-projection-disabled',
    });
  }
  if (!['matched', 'adopted'].includes(result.kind)) {
    return decision(field, 'unknown', {
      authority: 'none',
      evidence: refs,
      reason: 'endpoint-not-safely-reconciled',
    });
  }

  // The legacy result records no per-operation discriminator between "schema absent" and
  // "schema skipped because the media type was unsupported". Do not fabricate absence.
  return decision(field, 'unknown', {
    authority: 'openapi',
    evidence: openapiRefs,
    reason: 'legacy-result-does-not-retain-none-vs-skipped-media-type',
  });
}

function securityDecision(result, refs) {
  const openapiRefs = onlyRole(refs, 'openapi');

  if (result.sourceSecurity !== undefined) {
    return decision('api.security.declared', 'resolved', {
      value: result.sourceSecurity,
      authority: 'openapi',
      evidence: openapiRefs,
      reason: result.sourceSecurity.length === 0
        ? 'operation-explicitly-declared-public'
        : 'operation-security-requirements-declared',
    });
  }
  if (result.securityUnresolvedReason) {
    return decision('api.security.declared', 'unknown', {
      authority: 'openapi',
      evidence: openapiRefs,
      reason: result.securityUnresolvedReason,
    });
  }
  if (!['matched', 'adopted'].includes(result.kind)) {
    return decision('api.security.declared', 'unknown', {
      authority: 'none',
      evidence: refs,
      reason: 'endpoint-not-safely-reconciled',
    });
  }

  // In OpenAPI an absent operation.security may inherit document-level security. The current
  // legacy index/reconciliation result does not retain document-level security, so absence here
  // cannot be promoted to public/absent.
  return decision('api.security.declared', 'unknown', {
    authority: 'openapi',
    evidence: openapiRefs,
    reason: 'root-security-inheritance-not-retained-by-legacy-result',
  });
}

export function buildEndpointDecision({
  endpointKey,
  result,
  sourceEndpoint = null,
  prefix = null,
  schemaProjection = null,
  sourceRef = null,
  openapiRef = null,
}) {
  if (typeof endpointKey !== 'string' || endpointKey.length === 0) {
    throw new TypeError('endpointKey must be a non-empty string');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || !ENDPOINT_KINDS.has(result.kind)) {
    throw new TypeError('result must be a reconciliation result with a supported kind');
  }
  if (sourceEndpoint != null && (typeof sourceEndpoint !== 'object' || Array.isArray(sourceEndpoint))) {
    throw new TypeError('sourceEndpoint must be an object or null');
  }

  const refs = evidenceRefs(sourceRef, openapiRef);
  const fields = operationDecisions(result, sourceEndpoint, prefix, refs);

  fields.push(schemaDecision('api.request.schema', result, {
    valueKey: 'requestBodySchema',
    unresolvedKey: 'schemaUnresolvedReason',
  }, refs, schemaProjection));
  fields.push(schemaDecision('api.response.schema', result, {
    valueKey: 'responseSchema',
    unresolvedKey: 'responseSchemaUnresolvedReason',
  }, refs, schemaProjection));
  fields.push(schemaDecision('api.error.schema', result, {
    valueKey: 'errorSchema',
    unresolvedKey: 'errorSchemaUnresolvedReason',
  }, refs, schemaProjection));
  fields.push(securityDecision(result, refs));

  fields.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  return { endpointKey, resolutionKind: result.kind, fields };
}

export function buildReconciliationDecisionGraph({
  reconciliation,
  sourceByEndpoint = new Map(),
  sourceRef,
  openapiRef,
}) {
  if (!reconciliation || !(reconciliation.byEndpoint instanceof Map)) {
    throw new TypeError('reconciliation.byEndpoint must be a Map');
  }
  if (!(sourceByEndpoint instanceof Map)) {
    throw new TypeError('sourceByEndpoint must be a Map');
  }
  if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
    throw new TypeError('sourceRef must be a non-empty string');
  }
  if (typeof openapiRef !== 'string' || openapiRef.length === 0) {
    throw new TypeError('openapiRef must be a non-empty string');
  }

  const endpoints = [];
  for (const [endpointKey, result] of reconciliation.byEndpoint.entries()) {
    endpoints.push(buildEndpointDecision({
      endpointKey,
      result,
      sourceEndpoint: sourceByEndpoint.get(endpointKey) ?? null,
      prefix: reconciliation.prefix ?? null,
      schemaProjection: reconciliation.schemaProjection ?? null,
      sourceRef,
      openapiRef,
    }));
  }
  endpoints.sort((a, b) => a.endpointKey.localeCompare(b.endpointKey, 'en'));

  const counts = { resolved: 0, conflict: 0, unknown: 0, absent: 0, skipped: 0 };
  for (const endpoint of endpoints) {
    for (const field of endpoint.fields) counts[field.state]++;
  }

  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    endpoints,
    counts,
  };
}

// Deliberately limited to route/operation identity. Schema/security promotion belongs to the
// future cross-track capability policy, not this T09-local shadow helper.
export function promotableOperationKeys(graph, requiredFields = ROUTE_PROMOTION_FIELDS) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  const required = new Set(requiredFields);
  const out = [];
  for (const endpoint of graph.endpoints) {
    const byField = new Map(endpoint.fields.map((field) => [field.field, field]));
    if ([...required].every((field) => byField.get(field)?.state === 'resolved')) {
      out.push(endpoint.endpointKey);
    }
  }
  return out;
}
