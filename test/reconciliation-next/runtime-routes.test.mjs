import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBinding } from '../../contracts/reconciliation-next/evidence-binding.mjs';
import {
  reconcileRuntimeRoutes,
  runtimeObservedOperationKeys,
  validateRuntimeRouteObservation,
} from '../../contracts/reconciliation-next/runtime-routes.mjs';
import {
  openapiInput,
  runtimeInput,
  sourceInput,
} from './approved-evidence-fixture.mjs';

function setup({
  routes = [{ method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' }],
  completeness = 'complete',
  runtimeOptions = {},
  source = sourceInput(),
  openapi = openapiInput(),
} = {}) {
  const { runtime, observation } = runtimeInput({
    source,
    openapi,
    routeRoutes: routes,
    completeness,
    ...runtimeOptions,
  });
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  return { source, openapi, runtime, observation, binding };
}

function graph(source, openapi, endpoints = [
  { endpointKey: '0:0', operationId: 'findWidget', method: 'GET', path: '/widgets/{id}' },
]) {
  const sourceRef = source.artifactRef.byte_sha256;
  const openapiRef = openapi.artifactRef.byte_sha256;
  const both = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    openApiContext: {
      attached: true,
      version: 'bskel.openapi-context-audit/0-draft',
      openapiRef,
    },
    endpoints: endpoints.map((entry) => ({
      endpointKey: entry.endpointKey,
      resolutionKind: 'matched',
      fields: [
        { field: 'operation.identity', state: 'resolved', authority: 'scan+openapi', evidence: both, value: entry.operationId },
        { field: 'http.method', state: 'resolved', authority: 'scan+openapi', evidence: both, value: entry.method },
        { field: 'http.path', state: 'resolved', authority: 'reconciled', evidence: both, value: entry.path },
      ],
    })),
    counts: { resolved: endpoints.length * 3, conflict: 0, unknown: 0, absent: 0, skipped: 0 },
  };
}

function reconcile(options = {}) {
  const fx = setup(options);
  return {
    ...fx,
    report: reconcileRuntimeRoutes({
      graph: graph(fx.source, fx.openapi, options.endpoints),
      binding: fx.binding,
      observation: fx.observation,
    }),
  };
}

test('exact T16-bound runtime route is observed', () => {
  const { report } = reconcile();
  assert.equal(report.state, 'ready');
  assert.equal(report.endpoints[0].state, 'observed');
  assert.deepEqual(runtimeObservedOperationKeys(report), ['0:0']);
  assert.deepEqual(report.runtimeOnlyRoutes, []);
});

test('runtime route may omit operationId when canonical method/path exactly match', () => {
  const { report } = reconcile({ routes: [{ method: 'GET', path: '/widgets/{id}' }] });
  assert.equal(report.endpoints[0].state, 'observed');
});

test('same runtime path/method with another operationId is conflict', () => {
  const { report } = reconcile({
    routes: [{ method: 'GET', path: '/widgets/{id}', operationId: 'differentId' }],
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-operation-id-conflict');
});

test('same operationId at another path is runtime route drift', () => {
  const { report } = reconcile({
    routes: [{ method: 'GET', path: '/v2/widgets/{id}', operationId: 'findWidget' }],
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-route-drift');
});

test('duplicate runtime operationId never first-wins', () => {
  const { report } = reconcile({
    routes: [
      { method: 'GET', path: '/v1/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/v2/widgets/{id}', operationId: 'findWidget' },
    ],
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'duplicate-runtime-operation-id');
  assert.equal(report.endpoints[0].candidates.length, 2);
});

test('complete runtime snapshot may prove route missing', () => {
  const { report } = reconcile({ routes: [], completeness: 'complete' });
  assert.equal(report.endpoints[0].state, 'missing');
  assert.equal(report.endpoints[0].reason, 'runtime-route-missing-from-complete-snapshot');
});

test('partial runtime snapshot absence remains unknown', () => {
  const { report } = reconcile({ routes: [], completeness: 'partial' });
  assert.equal(report.endpoints[0].state, 'unknown');
  assert.equal(report.endpoints[0].reason, 'runtime-observation-partial');
});

test('runtime-only route stays separate from source/spec endpoint', () => {
  const { report } = reconcile({
    routes: [
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/runtime-only', operationId: 'runtimeOnly' },
    ],
  });
  assert.equal(report.endpoints[0].state, 'observed');
  assert.deepEqual(report.runtimeOnlyRoutes, [
    { method: 'GET', path: '/runtime-only', operationId: 'runtimeOnly' },
  ]);
});

test('runtime reconciliation is blocked until OpenAPI context audit is attached', () => {
  const fx = setup();
  const noContext = graph(fx.source, fx.openapi);
  delete noContext.openApiContext;
  const report = reconcileRuntimeRoutes({
    graph: noContext,
    binding: fx.binding,
    observation: fx.observation,
  });
  assert.equal(report.state, 'blocked');
  assert.equal(report.reason, 'openapi-context-not-attached');
});

test('tampered runtime binding hash in observation is rejected', () => {
  const fx = setup();
  const observation = { ...fx.observation, runtimeBindingHash: 'f'.repeat(64) };
  const result = validateRuntimeRouteObservation(observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-observation-binding-hash-mismatch');
});

test('tampered profile approval hash in observation is rejected', () => {
  const fx = setup();
  const observation = { ...fx.observation, profileApprovalHash: 'f'.repeat(64) };
  const result = validateRuntimeRouteObservation(observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-observation-profile-mismatch');
});

test('tampered attempt nonce in observation is rejected', () => {
  const fx = setup();
  const observation = { ...fx.observation, attemptNonce: '223e4567-e89b-42d3-a456-426614174000' };
  const result = validateRuntimeRouteObservation(observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-observation-attempt-mismatch');
});

test('route observation content not present in bound candidate evidence is rejected', () => {
  const fx = setup();
  const observation = {
    ...fx.observation,
    routes: [{ method: 'GET', path: '/other', operationId: 'findWidget' }],
  };
  const result = validateRuntimeRouteObservation(observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-route-observation-content-mismatch');
});

test('duplicate exact runtime route entries are rejected', () => {
  const fx = setup({
    routes: [
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/widgets/{id}' },
    ],
  });
  const result = validateRuntimeRouteObservation(fx.observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate-runtime-route-entry');
});

test('canonical duplicate {id} and :widgetId routes are rejected', () => {
  const fx = setup({
    routes: [
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/widgets/:widgetId', operationId: 'findWidgetAlias' },
    ],
  });
  const result = validateRuntimeRouteObservation(fx.observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate-runtime-route-entry');
});

test('Express-style :param route matches OpenAPI-style {param}', () => {
  const { report } = reconcile({
    routes: [{ method: 'GET', path: '/widgets/:id', operationId: 'findWidget' }],
  });
  assert.equal(report.endpoints[0].state, 'observed');
  assert.equal(report.endpoints[0].reason, 'runtime-route-shape-match');
});

test('regex-constrained :param route matches the same canonical shape', () => {
  const { report } = reconcile({
    routes: [{ method: 'GET', path: '/widgets/:id([0-9]+)', operationId: 'findWidget' }],
  });
  assert.equal(report.endpoints[0].state, 'observed');
  assert.equal(report.endpoints[0].reason, 'runtime-route-shape-match');
});

test('canonical matching does not hide literal path drift', () => {
  const { report } = reconcile({
    routes: [{ method: 'GET', path: '/gadgets/:id', operationId: 'findWidget' }],
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-route-drift');
});

test('invalid operationId syntax is rejected inside a bound observation', () => {
  const fx = setup({
    routes: [{ method: 'GET', path: '/widgets/{id}', operationId: '__proto__' }],
  });
  const result = validateRuntimeRouteObservation(fx.observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-route-0-invalid-operation-id');
});

test('control characters in runtime path are rejected', () => {
  const fx = setup({
    routes: [{ method: 'GET', path: '/widgets\n/hidden', operationId: 'findWidget' }],
  });
  const result = validateRuntimeRouteObservation(fx.observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-route-0-invalid-path');
});

test('overlong runtime path is rejected before canonical matching', () => {
  const fx = setup({
    routes: [{ method: 'GET', path: '/' + 'a'.repeat(4097), operationId: 'findWidget' }],
  });
  const result = validateRuntimeRouteObservation(fx.observation, fx.binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-route-0-invalid-path');
});

test('runtimeObservedOperationKeys rejects foreign or unversioned reports', () => {
  assert.deepEqual(runtimeObservedOperationKeys({
    state: 'ready',
    endpoints: [{ endpointKey: '0:0', state: 'observed' }],
  }), []);
  assert.deepEqual(runtimeObservedOperationKeys({
    version: 'other/runtime-report',
    state: 'ready',
    endpoints: [{ endpointKey: '0:0', state: 'observed' }],
  }), []);
});
