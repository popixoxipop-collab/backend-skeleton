import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexOpenApiDocument, reconcileModule } from '../../contracts/openapi.mjs';
import { buildReconciliationDecisionGraph } from '../../contracts/reconciliation-next/decision-graph.mjs';
import {
  applyOpenApiContext,
  buildOpenApiContext,
  contextBoundPromotableOperationKeys,
} from '../../contracts/reconciliation-next/openapi-context.mjs';

const refs = { sourceRef: 'scan:sha256:differential', openapiRef: 'openapi:sha256:differential' };
const field = (graph, name) => graph.endpoints[0].fields.find((entry) => entry.field === name);

function run(doc, endpoint, { pathPrefix = null } = {}) {
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
  return {
    reconciliation,
    graph: applyOpenApiContext(base, context),
  };
}

test('stale OpenAPI with same operationId but unrelated path blocks context-bound promotion', () => {
  const { reconciliation, graph } = run({
    openapi: '3.1.0',
    paths: {
      '/totally/unrelated': { get: { operationId: 'findWidget' } },
    },
  }, {
    verb: 'GET',
    path: '/widgets/{id}',
    operationId: 'findWidget',
    operationIdSource: 'source',
    method: 'findWidget',
  });

  assert.equal(reconciliation.byEndpoint.get('0:0').kind, 'drift');
  assert.equal(reconciliation.byEndpoint.get('0:0').reason, 'path');
  assert.equal(field(graph, 'operation.identity').state, 'resolved');
  assert.equal(field(graph, 'http.method').state, 'resolved');
  assert.equal(field(graph, 'http.path').state, 'conflict');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), []);
});

test('stale OpenAPI with same operationId but changed method keeps exact path and blocks promotion on method conflict', () => {
  const { reconciliation, graph } = run({
    openapi: '3.1.0',
    paths: {
      '/widgets/{id}': { post: { operationId: 'findWidget' } },
    },
  }, {
    verb: 'GET',
    path: '/widgets/{id}',
    operationId: 'findWidget',
    operationIdSource: 'source',
    method: 'findWidget',
  });

  assert.equal(reconciliation.byEndpoint.get('0:0').kind, 'drift');
  assert.equal(reconciliation.byEndpoint.get('0:0').reason, 'verb');
  assert.equal(field(graph, 'http.method').state, 'conflict');
  assert.equal(field(graph, 'http.path').state, 'resolved');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), []);
});

test('a scanner-synthesized id is ignored and a unique route adopts the OpenAPI-authored id', () => {
  const { reconciliation, graph } = run({
    openapi: '3.1.0',
    paths: {
      '/widgets': { post: { operationId: 'createWidgetFromSpec' } },
    },
  }, {
    verb: 'POST',
    path: '/widgets',
    operationId: 'bskelSynthesizedCreateWidget',
    operationIdSource: 'bskel-synthesized',
    method: 'createWidget',
  });

  assert.equal(reconciliation.byEndpoint.get('0:0').kind, 'adopted');
  assert.equal(field(graph, 'operation.identity').value, 'createWidgetFromSpec');
  assert.equal(field(graph, 'operation.identity').authority, 'openapi');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), ['0:0']);
});

test('prefixed and bare route candidates stay ambiguous instead of picking one', () => {
  const { reconciliation, graph } = run({
    openapi: '3.1.0',
    paths: {
      '/api/reports': { get: { operationId: 'findReportsPrefixed' } },
      '/reports': { get: { operationId: 'findReportsBare' } },
    },
  }, {
    verb: 'GET',
    path: '/reports',
    operationId: 'bskelSynthesizedReports',
    operationIdSource: 'bskel-synthesized',
    method: 'reports',
  }, { pathPrefix: '/api' });

  assert.equal(reconciliation.byEndpoint.get('0:0').kind, 'ambiguous');
  assert.equal(field(graph, 'operation.identity').state, 'conflict');
  assert.equal(field(graph, 'http.path').state, 'conflict');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), []);
});

test('a unique route without an OpenAPI operationId remains unresolved and non-promotable', () => {
  const { reconciliation, graph } = run({
    openapi: '3.1.0',
    paths: {
      '/widgets': { get: { responses: { '204': { description: 'ok' } } } },
    },
  }, {
    verb: 'GET',
    path: '/widgets',
    operationId: 'bskelSynthesizedFindWidgets',
    operationIdSource: 'bskel-synthesized',
    method: 'findWidgets',
  });

  assert.equal(reconciliation.byEndpoint.get('0:0').kind, 'unresolved');
  assert.equal(reconciliation.byEndpoint.get('0:0').reason, 'document-missing-operation-id');
  assert.equal(field(graph, 'operation.identity').state, 'unknown');
  assert.deepEqual(contextBoundPromotableOperationKeys(graph), []);
});
