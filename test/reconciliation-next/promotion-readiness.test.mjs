import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBinding } from '../../contracts/reconciliation-next/evidence-binding.mjs';
import { buildPromotionReadinessReport } from '../../contracts/reconciliation-next/promotion-readiness.mjs';

const sourceRef = 'scan:sha256:source';
const openapiRef = 'openapi:sha256:document';
const runtimeRef = 'runtime:sha256:routes';

function binding({ runtime = true, openapiRevision = 'abc123' } = {}) {
  return buildEvidenceBinding({
    source: { ref: sourceRef, repository: 'repo/example', revision: 'abc123' },
    openapi: {
      ref: openapiRef,
      repository: 'repo/example',
      revision: openapiRevision,
      ...(runtime ? { buildFingerprint: 'build-1' } : {}),
    },
    runtime: runtime ? {
      ref: runtimeRef,
      repository: 'repo/example',
      revision: 'abc123',
      buildFingerprint: 'build-1',
      environmentFingerprint: 'env-1',
    } : null,
  });
}

function endpoint({
  endpointKey = '0:0',
  identityState = 'resolved',
  methodState = 'resolved',
  pathState = 'resolved',
} = {}) {
  const evidence = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    endpointKey,
    fields: [
      { field: 'operation.identity', state: identityState, value: identityState === 'resolved' ? 'findWidget' : undefined, evidence, reason: identityState === 'resolved' ? undefined : 'identity-conflict' },
      { field: 'http.method', state: methodState, value: methodState === 'resolved' ? 'GET' : undefined, evidence, reason: methodState === 'resolved' ? undefined : 'method-conflict' },
      { field: 'http.path', state: pathState, value: pathState === 'resolved' ? '/widgets' : undefined, evidence, reason: pathState === 'resolved' ? undefined : 'path-conflict' },
    ],
  };
}

function graph(endpoints = [endpoint()], { context = true } = {}) {
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    ...(context ? { openApiContext: { attached: true, version: 'bskel.openapi-context-audit/0-draft', openapiRef } } : {}),
    endpoints,
  };
}

function runtimeReport(entries = [{
  endpointKey: '0:0',
  state: 'observed',
  reason: 'runtime-route-exact-match',
  expected: { operationId: 'findWidget', method: 'GET', path: '/widgets' },
}], overrides = {}) {
  return {
    version: 'bskel.runtime-route-reconciliation/0-draft',
    state: 'ready',
    sourceRef,
    openapiRef,
    runtimeRef,
    endpoints: entries,
    ...overrides,
  };
}

test('source/spec readiness is true when route fields, context and exact revision binding are ready', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding({ runtime: false }),
  });
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.endpoints[0].sourceSpecReady, true);
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
});

test('runtime route readiness becomes true only with bound runtime and an observed route result', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport(),
  });
  assert.equal(report.endpoints[0].sourceSpecReady, true);
  assert.equal(report.endpoints[0].runtimeRouteReady, true);
  assert.deepEqual(report.endpoints[0].runtimeBlockers, []);
});

test('a path conflict is reported as a source/spec blocker', () => {
  const report = buildPromotionReadinessReport({
    graph: graph([endpoint({ pathState: 'conflict' })]),
    binding: binding(),
    runtimeReport: runtimeReport(),
  });
  assert.equal(report.endpoints[0].sourceSpecReady, false);
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.deepEqual(report.endpoints[0].sourceSpecBlockers, [{
    code: 'route-field-not-resolved',
    field: 'http.path',
    state: 'conflict',
    reason: 'path-conflict',
  }]);
});

test('OpenAPI context audit is a required source/spec readiness input', () => {
  const report = buildPromotionReadinessReport({
    graph: graph([endpoint()], { context: false }),
    binding: binding(),
    runtimeReport: runtimeReport(),
  });
  assert.equal(report.endpoints[0].sourceSpecReady, false);
  assert.equal(report.endpoints[0].sourceSpecBlockers[0].code, 'openapi-context-not-attached');
});

test('revision mismatch is exposed as a binding blocker instead of being repaired', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding({ openapiRevision: 'different' }),
  });
  const blocker = report.endpoints[0].sourceSpecBlockers.find((entry) => entry.code === 'source-spec-binding-not-bound');
  assert.equal(blocker.state, 'conflict');
  assert.equal(blocker.reason, 'source-openapi-revision-mismatch');
});

test('a complete runtime report that says route missing remains a runtime blocker', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport([
      { endpointKey: '0:0', state: 'missing', reason: 'runtime-route-missing-from-complete-snapshot' },
    ]),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.deepEqual(report.endpoints[0].runtimeBlockers, [{
    code: 'runtime-route-not-observed',
    state: 'missing',
    reason: 'runtime-route-missing-from-complete-snapshot',
  }]);
});

test('runtime report from a different runtime ref is rejected as readiness input', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport(undefined, { runtimeRef: 'runtime:sha256:other' }),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-ref-mismatch');
});

test('readiness counts are aggregated without changing endpoint decisions', () => {
  const report = buildPromotionReadinessReport({
    graph: graph([
      endpoint({ endpointKey: '0:0' }),
      endpoint({ endpointKey: '0:1', identityState: 'conflict' }),
    ]),
    binding: binding(),
    runtimeReport: runtimeReport([
      {
        endpointKey: '0:0',
        state: 'observed',
        reason: 'runtime-route-exact-match',
        expected: { operationId: 'findWidget', method: 'GET', path: '/widgets' },
      },
      {
        endpointKey: '0:1',
        state: 'observed',
        reason: 'runtime-route-exact-match',
        expected: { operationId: 'findWidget', method: 'GET', path: '/widgets' },
      },
    ]),
  });
  assert.deepEqual(report.counts, {
    endpoints: 2,
    sourceSpecReady: 1,
    runtimeRouteReady: 1,
  });
});


test('readiness rejects a foreign runtime report version even when it claims observed', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport(undefined, {
      version: 'other/runtime-report',
      state: 'ready',
    }),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-version-unsupported');
});


test('runtime readiness rejects a report bound to a different source ref', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport(undefined, { sourceRef: 'scan:sha256:other' }),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-source-ref-mismatch');
});

test('runtime readiness rejects a report bound to a different OpenAPI ref', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport(undefined, { openapiRef: 'openapi:sha256:other' }),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-openapi-ref-mismatch');
});

test('runtime readiness rejects an observed endpoint whose expected route was tampered', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport([{
      endpointKey: '0:0',
      state: 'observed',
      reason: 'runtime-route-exact-match',
      expected: { operationId: 'findWidget', method: 'GET', path: '/other' },
    }]),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-expected-route-mismatch');
});

test('runtime readiness rejects an observed endpoint missing its expected route binding', () => {
  const report = buildPromotionReadinessReport({
    graph: graph(),
    binding: binding(),
    runtimeReport: runtimeReport([{
      endpointKey: '0:0',
      state: 'observed',
      reason: 'runtime-route-exact-match',
    }]),
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-expected-route-mismatch');
});
