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
  const context = buildOpenApiContext({ doc, index, reconciliation, openapiRef: refs.openapiRef });
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


test('matched operation with no request body narrows request schema from unknown to absent', () => {
  const { base, graph } = pipeline({
    openapi: '3.1.0',
    paths: { '/widgets': { get: { operationId: 'findWidgets' } } },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  assert.equal(field(base, 'api.request.schema').state, 'unknown');
  assert.equal(field(graph, 'api.request.schema').state, 'absent');
  assert.equal(field(graph, 'api.request.schema').reason, 'request-body-absent');
});

test('request body with only multipart narrows request schema to skipped media type', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            content: {
              'multipart/form-data': { schema: { type: 'object' } },
            },
          },
        },
      },
    },
  }, {
    verb: 'POST', path: '/upload', operationId: 'upload', operationIdSource: 'source', method: 'upload',
  });

  assert.equal(field(graph, 'api.request.schema').state, 'skipped');
  assert.equal(field(graph, 'api.request.schema').reason, 'request-json-media-type-absent');
});

test('request application/json entry without schema narrows request schema to absent', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        post: {
          operationId: 'createWidget',
          requestBody: { content: { 'application/json': {} } },
        },
      },
    },
  }, {
    verb: 'POST', path: '/widgets', operationId: 'createWidget', operationIdSource: 'source', method: 'createWidget',
  });

  assert.equal(field(graph, 'api.request.schema').state, 'absent');
  assert.equal(field(graph, 'api.request.schema').reason, 'request-json-schema-absent');
});

test('success response with only text/csv narrows response schema to skipped media type', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/report': {
        get: {
          operationId: 'report',
          responses: {
            '200': { description: 'csv', content: { 'text/csv': { schema: { type: 'string' } } } },
          },
        },
      },
    },
  }, {
    verb: 'GET', path: '/report', operationId: 'report', operationIdSource: 'source', method: 'report',
  });

  assert.equal(field(graph, 'api.response.schema').state, 'skipped');
  assert.equal(field(graph, 'api.response.schema').reason, 'response-json-media-type-absent');
});

test('204 success response with no content narrows response schema to absent', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        delete: {
          operationId: 'deleteWidget',
          responses: { '204': { description: 'deleted' } },
        },
      },
    },
  }, {
    verb: 'DELETE', path: '/widgets', operationId: 'deleteWidget', operationIdSource: 'source', method: 'deleteWidget',
  });

  assert.equal(field(graph, 'api.response.schema').state, 'absent');
  assert.equal(field(graph, 'api.response.schema').reason, 'response-json-schema-absent');
});

test('default error response with non-JSON content narrows error schema to skipped media type', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        get: {
          operationId: 'findWidgets',
          responses: {
            default: { description: 'error', content: { 'text/plain': { schema: { type: 'string' } } } },
          },
        },
      },
    },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  assert.equal(field(graph, 'api.error.schema').state, 'skipped');
  assert.equal(field(graph, 'api.error.schema').reason, 'error-json-media-type-absent');
});


test('unresolvable requestBody component ref stays unknown instead of being called absent', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        post: {
          operationId: 'createWidget',
          requestBody: { '$ref': '#/components/requestBodies/Ghost' },
        },
      },
    },
    components: { requestBodies: {} },
  }, {
    verb: 'POST', path: '/widgets', operationId: 'createWidget', operationIdSource: 'source', method: 'createWidget',
  });

  assert.equal(field(graph, 'api.request.schema').state, 'unknown');
  assert.equal(field(graph, 'api.request.schema').reason, 'request-body-unresolved-or-malformed');
});

test('unresolvable success response component ref stays unknown instead of being called absent', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/widgets': {
        get: {
          operationId: 'findWidgets',
          responses: {
            '200': { '$ref': '#/components/responses/Ghost' },
          },
        },
      },
    },
    components: { responses: {} },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  assert.equal(field(graph, 'api.response.schema').state, 'unknown');
  assert.equal(field(graph, 'api.response.schema').reason, 'response-object-unresolved-or-malformed');
});

test('context-bound promotion rejects a spoofed attached flag without versioned OpenAPI provenance', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: { '/widgets': { get: { operationId: 'findWidgets' } } },
  }, {
    verb: 'GET', path: '/widgets', operationId: 'findWidgets', operationIdSource: 'source', method: 'findWidgets',
  });

  const spoofed = {
    ...graph,
    openApiContext: { attached: true, version: 'bskel.openapi-context-audit/0-draft' },
  };
  assert.deepEqual(contextBoundPromotableOperationKeys(spoofed), []);
});


test('malformed operation security does not silently inherit a secured document root', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/profile': {
        get: {
          operationId: 'profile',
          security: { bearerAuth: [] },
        },
      },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'malformed-operation-security');
});

test('malformed operation security does not become declared-security absent when the root has no security', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/profile': {
        get: {
          operationId: 'profile',
          security: 'not-an-array',
        },
      },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'malformed-operation-security');
});


test('document security with non-array scopes stays unknown', () => {
  const { context, graph } = pipeline({
    openapi: '3.1.0',
    security: [{ bearerAuth: 'not-an-array' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    paths: {
      '/profile': { get: { operationId: 'profile' } },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(context.rootSecurity.state, 'unknown');
  assert.equal(context.rootSecurity.reason, 'malformed-document-security-scopes');
  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'malformed-document-security-scopes');
});

test('operation security with non-string scope values is downgraded to unknown even if legacy copied it', () => {
  const { base, graph } = pipeline({
    openapi: '3.1.0',
    components: {
      securitySchemes: {
        oauth: { type: 'oauth2', flows: {} },
      },
    },
    paths: {
      '/profile': {
        get: {
          operationId: 'profile',
          security: [{ oauth: ['read', 123] }],
        },
      },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(field(base, 'api.security.declared').state, 'resolved');
  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'malformed-operation-security-scopes');
});

test('operation security naming an unknown scheme remains unknown in the context audit', () => {
  const { graph } = pipeline({
    openapi: '3.1.0',
    paths: {
      '/profile': {
        get: {
          operationId: 'profile',
          security: [{ ghost: [] }],
        },
      },
    },
  }, {
    verb: 'GET', path: '/profile', operationId: 'profile', operationIdSource: 'source', method: 'profile',
  });

  assert.equal(field(graph, 'api.security.declared').state, 'unknown');
  assert.equal(field(graph, 'api.security.declared').reason, 'unknown-operation-security-scheme');
});
