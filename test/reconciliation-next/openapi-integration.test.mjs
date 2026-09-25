import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexOpenApiDocument, reconcileModule } from '../../contracts/openapi.mjs';
import {
  buildReconciliationDecisionGraph,
  promotableOperationKeys,
} from '../../contracts/reconciliation-next/decision-graph.mjs';

const refs = { sourceRef: 'scan:sha256:fixture', openapiRef: 'openapi:sha256:fixture' };
const oneModule = (endpoint) => ({
  module: 'x',
  controllers: [{ className: 'X', basePath: '/', file: null, endpoints: [endpoint] }],
});
const field = (graph, name) => graph.endpoints[0].fields.find((entry) => entry.field === name);

function graphFor(doc, endpoint, { pathPrefix = null } = {}) {
  const indexed = indexOpenApiDocument(doc);
  assert.equal(indexed.ok, true);
  const module = oneModule(endpoint);
  const reconciliation = reconcileModule({ index: indexed, module, pathPrefix });
  return buildReconciliationDecisionGraph({
    reconciliation,
    sourceByEndpoint: new Map([['0:0', endpoint]]),
    ...refs,
  });
}

test('real legacy reconciliation -> shadow graph preserves route match and refuses root-security guess', () => {
  const graph = graphFor({
    openapi: '3.1.0',
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/api/widgets/{id}': {
        get: { operationId: 'findWidget' },
      },
    },
  }, {
    verb: 'GET',
    path: '/widgets/{id}',
    operationId: 'findWidget',
    operationIdSource: 'source',
    method: 'findWidget',
  }, { pathPrefix: '/api' });

  assert.deepEqual(promotableOperationKeys(graph), ['0:0']);
  assert.equal(field(graph, 'http.path').value, '/api/widgets/{id}');
  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'root-security-inheritance-not-retained-by-legacy-result');
});

test('real legacy reconciliation -> explicit operation security [] is preserved as declared public', () => {
  const graph = graphFor({
    openapi: '3.1.0',
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/health': {
        get: { operationId: 'health', security: [] },
      },
    },
  }, {
    verb: 'GET',
    path: '/health',
    operationId: 'health',
    operationIdSource: 'source',
    method: 'health',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'resolved');
  assert.deepEqual(field(graph, 'api.security.declared').value, []);
  assert.equal(field(graph, 'api.security.declared').reason, 'operation-explicitly-declared-public');
});

test('real legacy reconciliation -> OpenAPI 3.0 keeps route identity but marks schema projection skipped', () => {
  const graph = graphFor({
    openapi: '3.0.3',
    paths: {
      '/widgets': {
        post: {
          operationId: 'createWidget',
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
            },
          },
        },
      },
    },
  }, {
    verb: 'POST',
    path: '/widgets',
    operationId: 'createWidget',
    operationIdSource: 'source',
    method: 'createWidget',
  });

  assert.equal(field(graph, 'operation.identity').state, 'resolved');
  assert.equal(field(graph, 'api.request.schema').state, 'skipped');
  assert.equal(field(graph, 'api.request.schema').reason, 'unsupported-openapi-version');
});

test('real legacy reconciliation -> missing source operation remains non-promotable and retains source candidate', () => {
  const graph = graphFor({
    openapi: '3.1.0',
    paths: {
      '/other': { get: { operationId: 'other' } },
    },
  }, {
    verb: 'GET',
    path: '/ghost',
    operationId: 'findGhost',
    operationIdSource: 'source',
    method: 'findGhost',
  });

  assert.deepEqual(promotableOperationKeys(graph), []);
  assert.equal(field(graph, 'operation.identity').state, 'unknown');
  assert.deepEqual(field(graph, 'operation.identity').candidates, ['findGhost']);
});
