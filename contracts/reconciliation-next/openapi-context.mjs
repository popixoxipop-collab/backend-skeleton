// T09 OpenAPI context audit.
//
// This module fills two pieces of context that the legacy reconciliation result intentionally does
// not retain: document-level security inheritance and duplicate operationId occurrences. It remains
// shadow-only and never mutates the stable OpenAPI index or contract writer.

import {
  ROUTE_PROMOTION_FIELDS,
  promotableOperationKeys,
} from './decision-graph.mjs';

const MAX_ROOT_SECURITY_REQUIREMENTS = 32;

function evidence(openapiRef) {
  return [{ role: 'openapi', ref: openapiRef }];
}

function validateRootSecurity(doc, index, openapiRef) {
  const refs = evidence(openapiRef);
  if (!Object.hasOwn(doc, 'security')) {
    return {
      state: 'absent',
      authority: 'openapi',
      evidence: refs,
      reason: 'document-security-absent',
    };
  }

  const security = doc.security;
  if (!Array.isArray(security)) {
    return {
      state: 'unknown',
      authority: 'openapi',
      evidence: refs,
      reason: 'malformed-document-security',
    };
  }
  if (security.length > MAX_ROOT_SECURITY_REQUIREMENTS) {
    return {
      state: 'unknown',
      authority: 'openapi',
      evidence: refs,
      reason: 'too-many-document-security-requirements',
    };
  }

  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      return {
        state: 'unknown',
        authority: 'openapi',
        evidence: refs,
        reason: 'malformed-document-security-requirement',
      };
    }
    for (const schemeName of Object.keys(requirement)) {
      if (!index.securitySchemes.has(schemeName)) {
        return {
          state: 'unknown',
          authority: 'openapi',
          evidence: refs,
          reason: 'unknown-document-security-scheme',
        };
      }
    }
  }

  return {
    state: 'resolved',
    authority: 'openapi',
    evidence: refs,
    value: security,
    reason: security.length === 0
      ? 'document-explicitly-declared-public'
      : 'document-security-requirements-declared',
  };
}

function collectOperationIdOccurrences(index) {
  const byId = new Map();
  const seenEntries = new Set();

  for (const entries of index.byRoute.values()) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || seenEntries.has(entry)) continue;
      seenEntries.add(entry);
      if (typeof entry.operationId !== 'string' || entry.operationId.length === 0) continue;
      const list = byId.get(entry.operationId) ?? [];
      list.push({ verb: entry.verb, path: entry.path });
      byId.set(entry.operationId, list);
    }
  }

  return [...byId.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([operationId, occurrences]) => ({
      operationId,
      occurrences: occurrences
        .slice()
        .sort((a, b) => (a.verb + ' ' + a.path).localeCompare(b.verb + ' ' + b.path, 'en')),
    }))
    .sort((a, b) => a.operationId.localeCompare(b.operationId, 'en'));
}

export function buildOpenApiContext({ doc, index, openapiRef }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('doc must be an OpenAPI document object');
  }
  if (!index || !(index.byRoute instanceof Map) || !(index.securitySchemes instanceof Map)) {
    throw new TypeError('index must be an OpenAPI index with byRoute/securitySchemes Maps');
  }
  if (typeof openapiRef !== 'string' || openapiRef.length === 0) {
    throw new TypeError('openapiRef must be a non-empty string');
  }

  return {
    version: 'bskel.openapi-context-audit/0-draft',
    openapiRef,
    rootSecurity: validateRootSecurity(doc, index, openapiRef),
    duplicateOperationIds: collectOperationIdOccurrences(index),
  };
}

function openapiRefsInGraph(graph) {
  const refs = new Set();
  for (const endpoint of graph.endpoints ?? []) {
    for (const field of endpoint.fields ?? []) {
      for (const item of field.evidence ?? []) {
        if (item?.role === 'openapi' && typeof item.ref === 'string') refs.add(item.ref);
      }
    }
  }
  return refs;
}

function countStates(endpoints) {
  const counts = { resolved: 0, conflict: 0, unknown: 0, absent: 0, skipped: 0 };
  for (const endpoint of endpoints) {
    for (const field of endpoint.fields) {
      if (!Object.hasOwn(counts, field.state)) {
        throw new TypeError('unsupported decision state in graph: ' + String(field.state));
      }
      counts[field.state]++;
    }
  }
  return counts;
}

export function applyOpenApiContext(graph, context) {
  if (!graph || !Array.isArray(graph.endpoints)) {
    throw new TypeError('graph.endpoints must be an array');
  }
  if (!context || context.version !== 'bskel.openapi-context-audit/0-draft') {
    throw new TypeError('context must be a T09 OpenAPI context audit');
  }

  const graphRefs = openapiRefsInGraph(graph);
  if (graphRefs.size > 0 && (graphRefs.size !== 1 || !graphRefs.has(context.openapiRef))) {
    throw new TypeError('OpenAPI context ref does not match decision graph provenance');
  }

  const duplicateIds = new Set(context.duplicateOperationIds.map((item) => item.operationId));
  const endpoints = graph.endpoints.map((endpoint) => ({
    ...endpoint,
    fields: endpoint.fields.map((field) => {
      if (field.field === 'operation.identity' && field.state === 'resolved' && duplicateIds.has(field.value)) {
        return {
          field: field.field,
          state: 'conflict',
          authority: 'conflict',
          evidence: evidence(context.openapiRef),
          reason: 'duplicate-openapi-operation-id',
        };
      }

      if (
        field.field === 'api.security.declared'
        && field.state === 'unknown'
        && field.reason === 'root-security-inheritance-not-retained-by-legacy-result'
      ) {
        if (context.rootSecurity.state === 'resolved') {
          return {
            field: field.field,
            state: 'resolved',
            authority: 'openapi',
            evidence: context.rootSecurity.evidence,
            value: context.rootSecurity.value,
            reason: 'inherited-document-security',
          };
        }
        if (context.rootSecurity.state === 'absent') {
          return {
            field: field.field,
            state: 'absent',
            authority: 'openapi',
            evidence: context.rootSecurity.evidence,
            reason: 'no-operation-or-document-security-declaration',
          };
        }
        return {
          field: field.field,
          state: 'unknown',
          authority: 'openapi',
          evidence: context.rootSecurity.evidence,
          reason: context.rootSecurity.reason,
        };
      }

      return field;
    }),
  }));

  return {
    ...graph,
    endpoints,
    counts: countStates(endpoints),
    openApiContext: {
      attached: true,
      version: context.version,
      openapiRef: context.openapiRef,
      duplicateOperationIdCount: context.duplicateOperationIds.length,
      rootSecurityState: context.rootSecurity.state,
    },
  };
}

export function contextBoundPromotableOperationKeys(
  graph,
  requiredFields = ROUTE_PROMOTION_FIELDS,
) {
  if (graph?.openApiContext?.attached !== true) return [];
  return promotableOperationKeys(graph, requiredFields);
}
