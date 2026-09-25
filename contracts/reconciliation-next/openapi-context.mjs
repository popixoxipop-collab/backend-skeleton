// T09 OpenAPI context audit.
//
// This module fills two pieces of context that the legacy reconciliation result intentionally does
// not retain: document-level security inheritance and duplicate operationId occurrences. It remains
// shadow-only and never mutates the stable OpenAPI index or contract writer.

import {
  DEFAULT_STATUS_KEY,
  ERROR_STATUS_RE,
  SUCCESS_STATUS_RE,
  canonicalRouteShape,
} from '../openapi.mjs';
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findUniqueEntry(index, result) {
  if (!['matched', 'adopted'].includes(result?.kind)) return null;
  if (typeof result.verb !== 'string' || typeof result.path !== 'string') return null;

  const key = result.verb + ' ' + canonicalRouteShape(result.path);
  const entries = index.byRoute.get(key) ?? [];
  const exact = entries.filter((entry) => (
    entry?.verb === result.verb
    && entry?.path === result.path
    && (result.operationId == null || entry.operationId === result.operationId)
  ));
  return exact.length === 1 ? exact[0] : null;
}

function findRawOperation(doc, result) {
  if (!['matched', 'adopted'].includes(result?.kind)) return null;
  if (!isObject(doc.paths) || typeof result.path !== 'string' || typeof result.verb !== 'string') return null;
  const pathItem = doc.paths[result.path];
  if (!isObject(pathItem)) return null;
  const operation = pathItem[result.verb.toLowerCase()];
  return isObject(operation) ? operation : null;
}

function requestSchemaPresence(entry, rawOperation) {
  if (!entry) return { state: 'unknown', reason: 'openapi-entry-not-unique' };
  if (!rawOperation) return { state: 'unknown', reason: 'raw-openapi-operation-not-found' };
  if (!Object.hasOwn(rawOperation, 'requestBody')) {
    return { state: 'absent', reason: 'request-body-absent' };
  }
  if (!entry.requestBody) {
    return { state: 'unknown', reason: 'request-body-unresolved-or-malformed' };
  }

  const content = entry.requestBody.content;
  if (!isObject(content) || !Object.hasOwn(content, 'application/json')) {
    return { state: 'skipped', reason: 'request-json-media-type-absent' };
  }
  const mediaEntry = content['application/json'];
  const schema = isObject(mediaEntry) ? mediaEntry.schema : null;
  if (!isObject(schema)) return { state: 'absent', reason: 'request-json-schema-absent' };
  return { state: 'present', reason: 'request-json-schema-present' };
}

function responseSchemaPresence(entry, rawOperation, statusRe, { includeDefault = false, kind } = {}) {
  if (!entry) return { state: 'unknown', reason: 'openapi-entry-not-unique' };
  if (!rawOperation) return { state: 'unknown', reason: 'raw-openapi-operation-not-found' };
  if (!Object.hasOwn(rawOperation, 'responses')) {
    return { state: 'absent', reason: kind + '-responses-absent' };
  }
  if (!isObject(rawOperation.responses) || !isObject(entry.responses)) {
    return { state: 'unknown', reason: kind + '-response-map-unresolved-or-malformed' };
  }

  let sawContentWithoutJson = false;
  let sawSchema = false;
  let sawUnresolved = false;
  for (const status of Object.keys(rawOperation.responses)) {
    if (!statusRe.test(status) && !(includeDefault && status === DEFAULT_STATUS_KEY)) continue;
    const rawResponse = rawOperation.responses[status];
    const response = entry.responses[status];
    if (!isObject(rawResponse) || !isObject(response)) {
      sawUnresolved = true;
      continue;
    }
    const content = response.content;
    if (!isObject(content)) continue;
    if (!Object.hasOwn(content, 'application/json')) {
      sawContentWithoutJson = true;
      continue;
    }
    const mediaEntry = content['application/json'];
    if (isObject(mediaEntry) && isObject(mediaEntry.schema)) sawSchema = true;
  }

  if (sawSchema) return { state: 'present', reason: kind + '-json-schema-present' };
  if (sawUnresolved) return { state: 'unknown', reason: kind + '-response-object-unresolved-or-malformed' };
  if (sawContentWithoutJson) return { state: 'skipped', reason: kind + '-json-media-type-absent' };
  return { state: 'absent', reason: kind + '-json-schema-absent' };
}

function collectSchemaPresence(doc, index, reconciliation) {
  const out = new Map();
  if (!reconciliation) return out;
  if (!(reconciliation.byEndpoint instanceof Map)) {
    throw new TypeError('reconciliation.byEndpoint must be a Map when supplied');
  }

  for (const [endpointKey, result] of reconciliation.byEndpoint.entries()) {
    const entry = findUniqueEntry(index, result);
    const rawOperation = findRawOperation(doc, result);
    out.set(endpointKey, {
      request: requestSchemaPresence(entry, rawOperation),
      response: responseSchemaPresence(entry, rawOperation, SUCCESS_STATUS_RE, { kind: 'response' }),
      error: responseSchemaPresence(entry, rawOperation, ERROR_STATUS_RE, { includeDefault: true, kind: 'error' }),
    });
  }
  return out;
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

export function buildOpenApiContext({ doc, index, reconciliation = null, openapiRef }) {
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
    schemaPresenceByEndpoint: collectSchemaPresence(doc, index, reconciliation),
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

function narrowLegacySchemaGap(field, endpointKey, context) {
  if (
    !['api.request.schema', 'api.response.schema', 'api.error.schema'].includes(field.field)
    || field.state !== 'unknown'
    || field.reason !== 'legacy-result-does-not-retain-none-vs-skipped-media-type'
  ) {
    return field;
  }

  const presence = context.schemaPresenceByEndpoint?.get(endpointKey);
  const slot = field.field === 'api.request.schema'
    ? presence?.request
    : field.field === 'api.response.schema'
      ? presence?.response
      : presence?.error;

  if (!slot) return field;
  if (slot.state === 'absent' || slot.state === 'skipped') {
    return {
      field: field.field,
      state: slot.state,
      authority: 'openapi',
      evidence: evidence(context.openapiRef),
      reason: slot.reason,
    };
  }
  if (slot.state === 'present') {
    return {
      field: field.field,
      state: 'unknown',
      authority: 'openapi',
      evidence: evidence(context.openapiRef),
      reason: 'openapi-schema-present-but-legacy-result-did-not-project',
    };
  }
  return {
    field: field.field,
    state: 'unknown',
    authority: 'openapi',
    evidence: evidence(context.openapiRef),
    reason: slot.reason || 'openapi-schema-presence-unknown',
  };
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
  if (graphRefs.size !== 1 || !graphRefs.has(context.openapiRef)) {
    throw new TypeError('OpenAPI context ref does not match decision graph provenance');
  }

  const duplicateIds = new Set(context.duplicateOperationIds.map((item) => item.operationId));
  const endpoints = graph.endpoints.map((endpoint) => ({
    ...endpoint,
    fields: endpoint.fields.map((field) => {
      const narrowed = narrowLegacySchemaGap(field, endpoint.endpointKey, context);
      if (narrowed !== field) return narrowed;

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
      schemaPresenceEndpointCount: context.schemaPresenceByEndpoint instanceof Map
        ? context.schemaPresenceByEndpoint.size
        : 0,
    },
  };
}

export function hasOpenApiContextAudit(graph) {
  if (
    graph?.openApiContext?.attached !== true
    || graph.openApiContext.version !== 'bskel.openapi-context-audit/0-draft'
    || typeof graph.openApiContext.openapiRef !== 'string'
    || graph.openApiContext.openapiRef.length === 0
  ) return false;

  const refs = openapiRefsInGraph(graph);
  return refs.size === 1 && refs.has(graph.openApiContext.openapiRef);
}

export function contextBoundPromotableOperationKeys(
  graph,
  requiredFields = ROUTE_PROMOTION_FIELDS,
) {
  if (!hasOpenApiContextAudit(graph)) return [];
  return promotableOperationKeys(graph, requiredFields);
}
