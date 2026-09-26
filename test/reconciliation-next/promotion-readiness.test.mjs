import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceBinding } from '../../contracts/reconciliation-next/evidence-binding.mjs';
import { buildPromotionReadinessReport } from '../../contracts/reconciliation-next/promotion-readiness.mjs';
import { reconcileRuntimeRoutes } from '../../contracts/reconciliation-next/runtime-routes.mjs';
import {
  openapiInput,
  runtimeInput,
  sourceInput,
} from './approved-evidence-fixture.mjs';

function endpoint({
  endpointKey = '0:0',
  operationId = 'findWidget',
  method = 'GET',
  path = '/widgets/{id}',
  identityState = 'resolved',
  methodState = 'resolved',
  pathState = 'resolved',
} = {}) {
  return { endpointKey, operationId, method, path, identityState, methodState, pathState };
}

function graph(source, openapi, endpoints = [endpoint()], { context = true } = {}) {
  const sourceRef = source.artifactRef.byte_sha256;
  const openapiRef = openapi.artifactRef.byte_sha256;
  const both = [
    { role: 'scan', ref: sourceRef },
    { role: 'openapi', ref: openapiRef },
  ];
  return {
    version: 'bskel.reconciliation-decision-graph/0-draft',
    ...(context ? {
      openApiContext: {
        attached: true,
        version: 'bskel.openapi-context-audit/0-draft',
        openapiRef,
      },
    } : {}),
    endpoints: endpoints.map((entry) => ({
      endpointKey: entry.endpointKey,
      fields: [
        {
          field: 'operation.identity',
          state: entry.identityState,
          ...(entry.identityState === 'resolved' ? { value: entry.operationId } : { reason: 'identity-conflict' }),
          evidence: both,
        },
        {
          field: 'http.method',
          state: entry.methodState,
          ...(entry.methodState === 'resolved' ? { value: entry.method } : { reason: 'method-conflict' }),
          evidence: both,
        },
        {
          field: 'http.path',
          state: entry.pathState,
          ...(entry.pathState === 'resolved' ? { value: entry.path } : { reason: 'path-conflict' }),
          evidence: both,
        },
      ],
    })),
  };
}

function setup({
  withRuntime = true,
  source = sourceInput(),
  openapi = openapiInput(),
  routes = [{ method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' }],
  completeness = 'complete',
  endpoints = [endpoint()],
  context = true,
  runtimeOptions = {},
} = {}) {
  let runtime = null;
  let observation = null;
  if (withRuntime) {
    const built = runtimeInput({
      source,
      openapi,
      routeRoutes: routes,
      completeness,
      ...runtimeOptions,
    });
    runtime = built.runtime;
    observation = built.observation;
  }
  const binding = buildEvidenceBinding({ source, openapi, runtime });
  const g = graph(source, openapi, endpoints, { context });
  const runtimeReport = withRuntime
    ? reconcileRuntimeRoutes({ graph: g, binding, observation })
    : null;
  return { source, openapi, binding, graph: g, runtimeReport };
}

test('source/spec readiness requires exact T01 artifact binding plus resolved route fields', () => {
  const fx = setup({ withRuntime: false });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
  });
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.stableCapabilityWire, false);
  assert.equal(report.endpoints[0].sourceSpecReady, true);
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.deepEqual(report.verifiedEvidence.sourceArtifactRef, fx.source.artifactRef);
  assert.deepEqual(report.verifiedEvidence.openapiArtifactRef, fx.openapi.artifactRef);
  assert.equal(report.verifiedEvidence.runtime, null);
});

test('runtime route readiness requires exact bound T16 evidence and an observed endpoint', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
  });
  assert.equal(report.endpoints[0].sourceSpecReady, true);
  assert.equal(report.endpoints[0].runtimeRouteReady, true);
  assert.deepEqual(report.endpoints[0].runtimeBlockers, []);
  assert.equal(report.verifiedEvidence.runtime.runtimeBindingHash, fx.binding.runtime.bindingHash);
  assert.equal(report.verifiedEvidence.runtime.profileApprovalHash, fx.binding.runtime.profileApprovalHash);
  assert.equal(report.verifiedEvidence.runtime.attemptNonce, fx.binding.runtime.attemptNonce);
});

test('path conflict remains an explicit source/spec blocker', () => {
  const fx = setup({
    endpoints: [endpoint({ pathState: 'conflict' })],
  });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
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

test('OpenAPI context audit is required before source/spec readiness', () => {
  const fx = setup({ context: false });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
  });
  assert.equal(report.endpoints[0].sourceSpecReady, false);
  assert.equal(report.endpoints[0].sourceSpecBlockers[0].code, 'openapi-context-not-attached');
});

test('repository/revision mismatch stays conflict and blocks readiness', () => {
  const openapi = openapiInput({ revision: 'different' });
  const fx = setup({ openapi, withRuntime: false });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
  });
  const blocker = report.endpoints[0].sourceSpecBlockers.find((entry) => entry.code === 'source-spec-binding-not-bound');
  assert.equal(blocker.state, 'conflict');
  assert.equal(blocker.reason, 'source-openapi-revision-mismatch');
});

test('partial runtime snapshot absence remains a runtime blocker, not absent', () => {
  const fx = setup({ routes: [], completeness: 'partial' });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
  });
  assert.equal(fx.runtimeReport.endpoints[0].state, 'unknown');
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.deepEqual(report.endpoints[0].runtimeBlockers, [{
    code: 'runtime-route-not-observed',
    state: 'unknown',
    reason: 'runtime-observation-partial',
  }]);
});

test('complete runtime snapshot missing route remains a blocker', () => {
  const fx = setup({ routes: [], completeness: 'complete' });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
  });
  assert.equal(fx.runtimeReport.endpoints[0].state, 'missing');
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-route-not-observed');
});

test('foreign runtime report version cannot satisfy readiness', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, version: 'other/runtime-report' },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-version-unsupported');
});

test('runtime report bound to another source ArtifactRef is rejected', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, sourceRef: 'f'.repeat(64) },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-source-ref-mismatch');
});

test('runtime report bound to another OpenAPI ArtifactRef is rejected', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, openapiRef: 'f'.repeat(64) },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-openapi-ref-mismatch');
});

test('runtime binding hash mismatch is rejected at readiness handoff', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, runtimeBindingHash: 'f'.repeat(64) },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-binding-hash-mismatch');
});

test('runtime profile mismatch is rejected at readiness handoff', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, profileApprovalHash: 'f'.repeat(64) },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-profile-mismatch');
});

test('runtime attempt mismatch is rejected at readiness handoff', () => {
  const fx = setup();
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, attemptNonce: '223e4567-e89b-42d3-a456-426614174000' },
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-report-attempt-mismatch');
});

test('runtime oracle/candidate evidence hash mismatch is rejected', () => {
  const fx = setup();
  const oracle = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, oracleEvidenceHash: 'f'.repeat(64) },
  });
  assert.equal(oracle.endpoints[0].runtimeBlockers[0].code, 'runtime-report-oracle-evidence-mismatch');

  const candidate = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: { ...fx.runtimeReport, candidateEvidenceHash: 'f'.repeat(64) },
  });
  assert.equal(candidate.endpoints[0].runtimeBlockers[0].code, 'runtime-report-candidate-evidence-mismatch');
});

test('tampered runtime expected route remains explicit blocker', () => {
  const fx = setup();
  const runtimeReport = structuredClone(fx.runtimeReport);
  runtimeReport.endpoints[0].expected.path = '/other';
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport,
  });
  assert.equal(report.endpoints[0].runtimeRouteReady, false);
  assert.equal(report.endpoints[0].runtimeBlockers[0].code, 'runtime-expected-route-mismatch');
});

test('readiness counts aggregate without weakening ordered endpoint decisions', () => {
  const fx = setup({
    endpoints: [
      endpoint({ endpointKey: '0:0' }),
      endpoint({ endpointKey: '0:1', identityState: 'conflict' }),
    ],
    routes: [{ method: 'GET', path: '/widgets/{id}', operationId: 'findWidget' }],
  });
  const report = buildPromotionReadinessReport({
    graph: fx.graph,
    binding: fx.binding,
    runtimeReport: fx.runtimeReport,
  });
  assert.deepEqual(report.counts, {
    endpoints: 2,
    sourceSpecReady: 1,
    runtimeRouteReady: 1,
  });
});
