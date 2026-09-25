import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEndpointDecision,
  buildReconciliationDecisionGraph,
  promotableOperationKeys,
} from '../../contracts/reconciliation-next/decision-graph.mjs';

const refs = { sourceRef: 'scan:sha256:source', openapiRef: 'openapi:sha256:document' };
const field = (endpoint, name) => endpoint.fields.find((entry) => entry.field === name);

test('matched route fields resolve but schema absence is not fabricated from the legacy result', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'matched', operationId: 'findWidget', verb: 'GET', path: '/api/widgets/{id}', scanVerb: 'GET', scanPath: '/widgets/{id}' },
    prefix: { value: '/api' },
    schemaProjection: { enabled: true, reason: null },
    ...refs,
  });
  assert.deepEqual(
    ['operation.identity', 'http.method', 'http.path'].map((name) => field(endpoint, name).state),
    ['resolved', 'resolved', 'resolved'],
  );
  assert.equal(field(endpoint, 'http.path').reason, 'prefix-reconciled');
  assert.equal(field(endpoint, 'api.request.schema').state, 'unknown');
  assert.equal(field(endpoint, 'api.request.schema').reason, 'legacy-result-does-not-retain-none-vs-skipped-media-type');
});

test('adopted operation identity is OpenAPI-authoritative', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'adopted', operationId: 'createWidget', verb: 'POST', path: '/api/widgets', scanVerb: 'POST', scanPath: '/widgets' },
    prefix: { value: '/api' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'resolved');
  assert.equal(field(endpoint, 'operation.identity').authority, 'openapi');
  assert.deepEqual(field(endpoint, 'operation.identity').evidence, [{ role: 'openapi', ref: refs.openapiRef }]);
});

test('verb drift keeps the source operation identity and independently proves a prefix-explained path', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'drift', reason: 'verb',
      openapi: { verb: 'POST', path: '/api/widgets/{id}' },
      scanVerb: 'GET', scanPath: '/widgets/{id}',
    },
    sourceEndpoint: { operationId: 'findWidget', operationIdSource: 'source' },
    prefix: { value: '/api' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').value, 'findWidget');
  assert.equal(field(endpoint, 'http.method').state, 'conflict');
  assert.deepEqual(field(endpoint, 'http.method').candidates, ['GET', 'POST']);
  assert.equal(field(endpoint, 'http.path').state, 'resolved');
  assert.equal(field(endpoint, 'http.path').value, '/api/widgets/{id}');
});

test('verb drift without source endpoint context does not invent an operation identity', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'drift', reason: 'verb', openapi: { verb: 'POST', path: '/x' }, scanVerb: 'GET', scanPath: '/x' },
    prefix: { value: '' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'unknown');
});

test('path drift resolves only the method and retains the path conflict', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'drift', reason: 'path',
      openapi: { verb: 'GET', path: '/elsewhere' },
      scanVerb: 'GET', scanPath: '/widgets',
    },
    sourceEndpoint: { operationId: 'findWidget', operationIdSource: 'source' },
    prefix: { value: '/api' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'http.method').state, 'resolved');
  assert.equal(field(endpoint, 'http.path').state, 'conflict');
  assert.deepEqual(field(endpoint, 'http.path').candidates, ['/widgets', '/elsewhere']);
});

test('missing OpenAPI operation does not promote source-only route facts', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'missing', scanVerb: 'GET', scanPath: '/ghosts/{id}' },
    sourceEndpoint: { operationId: 'findGhost', operationIdSource: 'source' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'unknown');
  assert.deepEqual(field(endpoint, 'operation.identity').candidates, ['findGhost']);
  assert.equal(field(endpoint, 'http.method').state, 'unknown');
  assert.equal(field(endpoint, 'http.path').state, 'unknown');
});

test('a synthesized scanner operation id is never promoted as source-authored identity', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'unresolved', reason: 'no-candidate', scanVerb: 'GET', scanPath: '/widgets' },
    sourceEndpoint: { operationId: 'bskelGenerated', operationIdSource: 'bskel-synthesized' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'unknown');
  assert.equal(field(endpoint, 'operation.identity').candidates, undefined);
});

test('ambiguous route preserves operation/path candidates and only resolves the method', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'ambiguous', scanVerb: 'GET', scanPath: '/reports',
      candidates: [
        { verb: 'GET', path: '/api/reports', operationId: 'findReportsPrefixed' },
        { verb: 'GET', path: '/reports', operationId: 'findReportsBare' },
      ],
    },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'conflict');
  assert.equal(field(endpoint, 'http.method').state, 'resolved');
  assert.equal(field(endpoint, 'http.path').state, 'conflict');
});

test('unresolved endpoint remains unknown', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'unresolved', reason: 'prefix-inconclusive', scanVerb: 'GET', scanPath: '/widgets' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'operation.identity').state, 'unknown');
  assert.equal(field(endpoint, 'http.method').state, 'unknown');
  assert.equal(field(endpoint, 'http.path').state, 'unknown');
});

test('resolved request/response/error schemas preserve OpenAPI authority', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'matched', operationId: 'createWidget', verb: 'POST', path: '/widgets', scanVerb: 'POST', scanPath: '/widgets',
      requestBodySchema: { type: 'object', required: ['name'] },
      responseSchema: { type: 'object', required: ['id'] },
      errorSchema: { type: 'object', required: ['message'] },
    },
    schemaProjection: { enabled: true },
    ...refs,
  });
  for (const name of ['api.request.schema', 'api.response.schema', 'api.error.schema']) {
    assert.equal(field(endpoint, name).state, 'resolved');
    assert.equal(field(endpoint, name).authority, 'openapi');
  }
});

test('schema resolution failures remain unknown with their exact reason', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'matched', operationId: 'createWidget', verb: 'POST', path: '/widgets', scanVerb: 'POST', scanPath: '/widgets',
      schemaUnresolvedReason: 'unsupported-keyword:not',
    },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'api.request.schema').state, 'unknown');
  assert.equal(field(endpoint, 'api.request.schema').reason, 'unsupported-keyword:not');
});

test('unsupported OpenAPI schema dialect is explicit skipped, not absent', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'matched', operationId: 'findWidget', verb: 'GET', path: '/widgets', scanVerb: 'GET', scanPath: '/widgets' },
    schemaProjection: { enabled: false, reason: 'unsupported-openapi-version' },
    ...refs,
  });
  for (const name of ['api.request.schema', 'api.response.schema', 'api.error.schema']) {
    assert.equal(field(endpoint, name).state, 'skipped');
    assert.equal(field(endpoint, name).reason, 'unsupported-openapi-version');
  }
});

test('unresolved operation security remains unknown', () => {
  const endpoint = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'matched', operationId: 'findWidget', verb: 'GET', path: '/widgets', scanVerb: 'GET', scanPath: '/widgets',
      securityUnresolvedReason: 'unknown-scheme',
    },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(endpoint, 'api.security.declared').state, 'unknown');
  assert.equal(field(endpoint, 'api.security.declared').reason, 'unknown-scheme');
});

test('explicit operation security [] means declared public; missing operation security stays unknown because root inheritance is lost', () => {
  const explicitPublic = buildEndpointDecision({
    endpointKey: '0:0',
    result: {
      kind: 'matched', operationId: 'health', verb: 'GET', path: '/health', scanVerb: 'GET', scanPath: '/health',
      sourceSecurity: [],
    },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(explicitPublic, 'api.security.declared').state, 'resolved');
  assert.deepEqual(field(explicitPublic, 'api.security.declared').value, []);
  assert.equal(field(explicitPublic, 'api.security.declared').reason, 'operation-explicitly-declared-public');

  const inheritedOrAbsent = buildEndpointDecision({
    endpointKey: '0:1',
    result: { kind: 'matched', operationId: 'profile', verb: 'GET', path: '/profile', scanVerb: 'GET', scanPath: '/profile' },
    schemaProjection: { enabled: true },
    ...refs,
  });
  assert.equal(field(inheritedOrAbsent, 'api.security.declared').state, 'unknown');
  assert.equal(field(inheritedOrAbsent, 'api.security.declared').reason, 'root-security-inheritance-not-retained-by-legacy-result');
});

test('decision graph binds provenance, counts states, and promotes route identity only', () => {
  const byEndpoint = new Map([
    ['0:0', { kind: 'matched', operationId: 'findWidget', verb: 'GET', path: '/api/widgets', scanVerb: 'GET', scanPath: '/widgets' }],
    ['0:1', { kind: 'missing', scanVerb: 'GET', scanPath: '/ghosts' }],
  ]);
  const sourceByEndpoint = new Map([
    ['0:0', { operationId: 'findWidget', operationIdSource: 'source' }],
    ['0:1', { operationId: 'findGhost', operationIdSource: 'source' }],
  ]);
  const graph = buildReconciliationDecisionGraph({
    reconciliation: {
      byEndpoint,
      prefix: { value: '/api' },
      schemaProjection: { enabled: true, reason: null },
    },
    sourceByEndpoint,
    ...refs,
  });
  assert.equal(graph.version, 'bskel.reconciliation-decision-graph/0-draft');
  assert.equal(graph.endpoints.length, 2);
  assert.deepEqual(promotableOperationKeys(graph), ['0:0']);
  assert.ok(graph.counts.resolved > 0);
  assert.ok(graph.counts.unknown > 0);
});

test('promotion remains blocked when security is explicitly required by a caller', () => {
  const graph = buildReconciliationDecisionGraph({
    reconciliation: {
      byEndpoint: new Map([
        ['0:0', { kind: 'matched', operationId: 'findWidget', verb: 'GET', path: '/widgets', scanVerb: 'GET', scanPath: '/widgets' }],
      ]),
      prefix: { value: '' },
      schemaProjection: { enabled: true },
    },
    sourceByEndpoint: new Map(),
    ...refs,
  });
  assert.deepEqual(
    promotableOperationKeys(graph, ['operation.identity', 'http.method', 'http.path', 'api.security.declared']),
    [],
  );
});

test('graph construction requires provenance references', () => {
  assert.throws(() => buildReconciliationDecisionGraph({
    reconciliation: { byEndpoint: new Map(), prefix: null, schemaProjection: null },
    sourceByEndpoint: new Map(),
    sourceRef: '',
    openapiRef: 'openapi:x',
  }), /sourceRef/);
});

test('unsupported reconciliation kind fails closed', () => {
  assert.throws(() => buildEndpointDecision({
    endpointKey: '0:0',
    result: { kind: 'surprise' },
    ...refs,
  }), /supported kind/);
});
