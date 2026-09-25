import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexOpenApiDocument, reconcileModule } from '../../contracts/openapi.mjs';
import { buildReconciliationDecisionGraph } from '../../contracts/reconciliation-next/decision-graph.mjs';
import {
  applyOpenApiContext,
  buildOpenApiContext,
  contextBoundPromotableOperationKeys,
} from '../../contracts/reconciliation-next/openapi-context.mjs';

const refs = { sourceRef: 'scan:sha256:fixture', openapiRef: 'openapi:sha256:fixture' };
const field = (graph, name) => graph.endpoints[0].fields.find((entry) => entry.field === name);

function pipeline(doc, endpoint, { pathPrefix = null } = {}) {
  const index = indexOpenApiDocument(doc);
  assert.equal(index.ok, true);
  const module = {
    module: 'x',
    controllers: [{ className: 'X', basePath: '/', file: null, endpoints: [endpoint] }],
  };
  const reconciliation = reconcileModule({ index, module, pathPrefix });
  const base = buildReconciliationDecisionGraph({
    reconciliation,
    sourceByEndpoint: new Map([['0:0', endpoint]]),
    ...refs,
  });
  const context = buildOpenApiContext({ doc, index, openapiRef: refs.openapiRef });
  return { index, context, base, graph: applyOpenApiContext(base, context) };
}

test('document-level security is inherited only after the raw OpenAPI context is attached', () => {
  const { base, graph, context } = pipeline({
    openapi: '3.1.0',
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/profile': { get: { operationId: 'profile' } },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(field(base, 'api.security.declared').state, 'unknown');
  assert.equal(context.rootSecurity.state, 'resolved');
  assert.equal(field(graph, 'api.security.declared').state, 'resolved');
  assert.deepEqual(field(graph, 'api.security.declared').value, [{ bearerAuth: [] }]);
  assert.equal(field(graph, 'api.security.declared').reason, 'inherited-document-security');
});

test('no operation security and no document security becomes declared-security absent, not runtime authorization proof', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: { '/health': { get: { operationId: 'health' } } },
  }, {
    verb: 'GET', path: '/health', operationId: 'health', operationIdSource: 'source', method: 'health',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'absent');
  assert.equal(field(graph, 'api.security.declared').reason, 'no-operation-or-document-security-declaration');
});

test('explicit operation security [] overrides a secured document root', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/health': { get: { operationId: 'health', security: [] } },
    },
  }, {
    verb: 'GET', path: '/health', operationId: 'health', operationIdSource: 'source', method: 'health',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'resolved');
  assert.deepEqual(field(graph, 'api.security.declared').value, []);
  assert.equal(field(graph, 'api.security.declared').reason, 'operation-explicitly-declared-public');
});

test('unknown document security scheme stays unknown', () => {
  const { context, graph } = pipeline({
    openapi: '3.1.0',
    security: [{ ghostAuth: [] }],
    paths: { '/profile': { get: { operationId: 'profile' } } },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(context.rootSecurity.state, 'unknown');
  assert.equal(context.rootSecurity.reason, 'unknown-document-security-scheme');
  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'unknown-document-security-scheme');
});

test('duplicate OpenAPI operationId is detected across route entries and blocks identity promotion', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/first': { get: { operationId: 'duplicateId' } },
      '/second': { post: { operationId: 'duplicateId' } },
    },
  };
  const endpoint = {
    verb: 'GET', path: '/first', operationId: 'duplicateId', operationIdSource: 'source', method: 'first',
  };
  const { context, base, graph } = pipeline(doc, endpoint);

  assert.equal(field(base, 'operation.identity').state, 'resolved');
  assert.equal(context.duplicateOperationIds.length, 1);
  assert.deepEqual(context.duplicateOperationIds[0], {
    operationId: 'duplicateId',
    occurrences: [
      { verb: 'GET', path: '/first' },
      { verb: 'POST', path: '/second' },
    ],
  });
  assert.equal(field(graph, 'operation.identity').state, 'conflict');
  assert.equal(field(graph, 'operation.identity').reason, 'duplicate-openapi-operation-id');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), []);
});

test('a unique operation becomes context-bound promotable after OpenAPI context audit', () => {
  const { base, graph } = pipeline({
    openapi: '3.1.0',
    paths: { '/widgets': { get: { operationId: 'findWidgets' } } },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  assert.deepEqual(contextBoundPromotableOperationKeys(base), []);
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), ['0:0']);
});

test('context application rejects a different OpenAPI provenance ref', () => {
  const { base, context } = pipeline({
    openapi: '3.1.0',
    paths: { '/widgets': { get: { operationId: 'findWidgets' } } },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  assert.throws(() => applyOpenApiContext(base, {
    ...context,
    openapiRef: 'openapi:sha256:different',
    rootSecurity: {
      ...context.rootSecurity,
      evidence: [{ role: 'openapi', ref: 'openapi:sha256:different' }],
    },
  }), /does not match/);
});

test('malformed document-level security is not treated as absent/public', () => {
  const doc = {
    openapi: '3.1.0',
    security: { bearerAuth: [] },
    paths: { '/profile': { get: { operationId: 'profile' } } },
  };
  const index = indexOpenApiDocument(doc);
  assert.equal(index.ok, true);
  const context = buildOpenApiContext({ doc, index, openapiRef: refs.openapiRef });
  assert.equal(context.rootSecurity.state, 'unknown');
  assert.equal(context.rootSecurity.reason, 'malformed-document-security');
});
