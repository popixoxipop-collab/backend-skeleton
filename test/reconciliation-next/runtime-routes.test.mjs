import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBinding } from '../../contracts/reconciliation-next/evidence-binding.mjs';
import {
  reconcileRuntimeRoutes,
  runtimeObservedOperationKeys,
  validateRuntimeRouteObservation,
} from '../../contracts/reconciliation-next/runtime-routes.mjs';

const sourceRef = 'scan:sha256:source';
const openapiRef = 'openapi:sha256:document';
const runtimeRef = 'runtime:sha256:routes';

function binding() {
  return buildEvidenceBinding({
    source: { ref: sourceRef, repository: 'repo/example', revision: 'abc123' },
    openapi: {
      ref: openapiRef,
      repository: 'repo/example',
      revision: 'abc123',
      buildFingerprint: 'build-1',
    },
    runtime: {
      ref: runtimeRef,
      repository: 'repo/example',
      revision: 'abc123',
      buildFingerprint: 'build-1',
      environmentFingerprint: 'env-1',
    },
  });
}

function graph(endpoints = [
  { endpointKey: '0:0', operationId: 'findWidget', method: 'GET', path: '/widgets/{id}' },
]) {
  const both = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    openApiContext: { attached: true, version: 'bskel.openapi-context-audit/0-draft' },
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

function observation(routes, completeness = 'complete', overrides = {}) {
  return {
    version: 'bskel.runtime-route-observation/0-draft',
    runtimeRef,
    repository: 'repo/example',
    revision: 'abc123',
    buildFingerprint: 'build-1',
    environmentFingerprint: 'env-1',
    completeness,
    routes,
    ...overrides,
  };
}

test('an exact bound runtime route is observed and promotable as runtime evidence', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.state, 'ready');
  assert.equal(report.endpoints[0].state, 'observed');
  assert.deepEqual(runtimeObservedOperationKeys(report), ['0:0']);
  assert.deepEqual(report.runtimeOnlyRoutes, []);
});

test('runtime route may omit operationId when method/path exactly match', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([{ method: 'GET', path: '/widgets/{id}' }]),
  });
  assert.equal(report.endpoints[0].state, 'observed');
});

test('same runtime path and method with a different operationId is a conflict', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}', operationId: 'differentId' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-operation-id-conflict');
  assert.deepEqual(runtimeObservedOperationKeys(report), []);
});

test('same operationId at a different runtime path is route drift', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/v2/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-route-drift');
});

test('duplicate runtime operationId across different routes is conflict, never first-wins', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/v1/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/v2/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'duplicate-runtime-operation-id');
  assert.equal(report.endpoints[0].candidates.length, 2);
});

test('a route missing from a complete snapshot is missing', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([]),
  });
  assert.equal(report.endpoints[0].state, 'missing');
  assert.equal(report.endpoints[0].reason, 'runtime-route-missing-from-complete-snapshot');
});

test('a route not seen in a partial snapshot remains unknown', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([], 'partial'),
  });
  assert.equal(report.endpoints[0].state, 'unknown');
  assert.equal(report.endpoints[0].reason, 'runtime-observation-partial');
});

test('runtime-only routes are surfaced separately instead of being attached to a source operation', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/runtime-only', operationId: 'runtimeOnly' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'observed');
  assert.deepEqual(report.runtimeOnlyRoutes, [
    { method: 'GET', path: '/runtime-only', operationId: 'runtimeOnly' },
  ]);
});

test('runtime observation with a different build is blocked before route comparison', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation(
      [{ method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' }],
      'complete',
      { buildFingerprint: 'different-build' },
    ),
  });
  assert.equal(report.state, 'blocked');
  assert.equal(report.reason, 'runtime-observation-build-mismatch');
  assert.deepEqual(report.endpoints, []);
});

test('runtime observation with a different environment is blocked', () => {
  const result = validateRuntimeRouteObservation(
    observation([], 'complete', { environmentFingerprint: 'other-env' }),
    binding(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-observation-environment-mismatch');
});

test('duplicate exact runtime route entries are rejected at envelope validation', () => {
  const result = validateRuntimeRouteObservation(observation([
    { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
    { method: 'GET', path: '/widgets/{id}' },
  ]), binding());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate-runtime-route-entry');
});


test('duplicate runtime operationId conflicts even when one duplicate is the exact expected route', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
      { method: 'GET', path: '/shadow/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'duplicate-runtime-operation-id');
  assert.deepEqual(runtimeObservedOperationKeys(report), []);
});

test('exact route without operationId conflicts when the expected operationId is observed on another route', () => {
  const report = reconcileRuntimeRoutes({
    graph: graph(),
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}' },
      { method: 'GET', path: '/v2/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.endpoints[0].state, 'conflict');
  assert.equal(report.endpoints[0].reason, 'runtime-operation-id-route-conflict');
});

test('runtime reconciliation is blocked until the OpenAPI context audit is attached', () => {
  const noContext = graph();
  delete noContext.openApiContext;
  const report = reconcileRuntimeRoutes({
    graph: noContext,
    binding: binding(),
    observation: observation([
      { method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' },
    ]),
  });
  assert.equal(report.state, 'blocked');
  assert.equal(report.reason, 'openapi-context-not-attached');
});
